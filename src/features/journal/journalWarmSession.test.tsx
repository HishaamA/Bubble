import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMemberSessionCaches } from '../../app/memberSessionCache'
import { notifyLocalCapsulesChanged } from '../capsules/capsuleChanges'
import type { FamilyCapsule } from '../capsules/types'
import type { JournalPhoto } from './journalPhotoTypes'

const mocks = vi.hoisted(() => ({
  archiveStore: vi.fn(), libraryStore: vi.fn(),
  archiveFetch: vi.fn(), libraryFetch: vi.fn(),
  archiveSubscribe: vi.fn(), librarySubscribe: vi.fn(), upload: vi.fn(),
  capsuleDeletions: vi.fn(), capsuleDeletionsSubscribe: vi.fn(),
}))
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) } }))
vi.mock('../capsules/capsuleStore', () => ({
  createDefaultCapsuleStore: mocks.archiveStore,
  createMemoryCapsuleStore: mocks.archiveStore,
}))
vi.mock('./journalPhotoStore', () => ({ createDefaultJournalPhotoStore: mocks.libraryStore }))
vi.mock('../capsules/capsuleService', () => ({
  fetchFamilyCapsules: mocks.archiveFetch,
  subscribeToFamilyCapsules: mocks.archiveSubscribe,
}))
vi.mock('../capsules/capsuleDeletionService', () => ({
  fetchFamilyCapsuleDeletions: mocks.capsuleDeletions,
  subscribeToFamilyCapsuleDeletions: mocks.capsuleDeletionsSubscribe,
}))
vi.mock('./journalPhotoService', () => ({
  fetchFamilyJournalPhotos: mocks.libraryFetch,
  subscribeToFamilyJournalPhotos: mocks.librarySubscribe,
  uploadFamilyJournalPhoto: mocks.upload,
}))

import { useJournalCapsuleArchive } from './capsuleJournalArchive'
import { useJournalPhotoLibrary } from './journalPhotoLibrary'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function photo(id: string): JournalPhoto {
  return {
    id, caption: id, image: new Blob([id]), thumbnail: new Blob([id]),
    width: 100, height: 100, capturedAt: '2026-01-01T00:00:00Z',
    contributorName: 'Maya', ownedByCurrentUser: true, syncStatus: 'synced',
  }
}
function capsule(id: string): FamilyCapsule {
  return {
    id, title: id, kind: 'special', createdAt: '2026-01-01T00:00:00Z',
    closesAt: '2026-01-02T00:00:00Z', opensAt: '2026-01-02T00:00:00Z',
    createdByName: 'Maya', familySynced: true,
    photos: [{ ...photo(id), syncStatus: 'synced', capsuleId: id }],
  }
}
function useArchiveSubject(namespace: string) {
  const data = useJournalCapsuleArchive({ cacheNamespace: namespace })
  return { rows: data.capsules, loading: data.loading, refresh: data.refresh }
}
function useLibrarySubject(namespace: string) {
  const data = useJournalPhotoLibrary({ cacheNamespace: namespace })
  return { rows: data.photos, loading: data.loading, refresh: data.refresh }
}

describe.each(['archive', 'library'] as const)('Journal %s warm session', (kind) => {
  const useSubject = kind === 'archive' ? useArchiveSubject : useLibrarySubject
  const makeRow = kind === 'archive' ? capsule : photo
  const factory = kind === 'archive' ? mocks.archiveStore : mocks.libraryStore
  const fetch = kind === 'archive' ? mocks.archiveFetch : mocks.libraryFetch
  const subscribe = kind === 'archive' ? mocks.archiveSubscribe : mocks.librarySubscribe
  const createStore = (rows: (FamilyCapsule | JournalPhoto)[] = []) => ({
    list: vi.fn(async () => rows), save: vi.fn(async () => undefined), remove: vi.fn(async () => undefined),
  })

  beforeEach(() => {
    clearMemberSessionCaches()
    vi.resetAllMocks()
    mocks.archiveFetch.mockResolvedValue([])
    mocks.libraryFetch.mockResolvedValue([])
    mocks.archiveSubscribe.mockResolvedValue(() => undefined)
    mocks.librarySubscribe.mockResolvedValue(() => undefined)
    mocks.upload.mockResolvedValue(null)
    mocks.capsuleDeletions.mockResolvedValue(null)
    mocks.capsuleDeletionsSubscribe.mockResolvedValue(() => undefined)
  })
  afterEach(() => {
    cleanup()
    clearMemberSessionCaches()
    vi.restoreAllMocks()
  })

  it('shows local photos before a slow family response and reuses them immediately on remount', async () => {
    const local = makeRow('local')
    const store = createStore([local])
    const network = deferred<(FamilyCapsule | JournalPhoto)[]>()
    factory.mockReturnValue(store)
    fetch.mockReturnValue(network.promise)
    const first = renderHook(() => useSubject('member:family'))
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    expect(first.result.current.rows).toEqual([local])
    first.unmount()
    const second = renderHook(() => useSubject('member:family'))
    expect(second.result.current.rows).toEqual([local])
    expect(second.result.current.loading).toBe(false)
    expect(store.list).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => { network.resolve([local]) })
    second.unmount()
    const third = renderHook(() => useSubject('member:family'))
    expect(third.result.current.rows).toEqual([local])
    expect(store.list).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(store.save).not.toHaveBeenCalled()
  })

  it('coalesces storage hydration and network reads across consumers and StrictMode replay', async () => {
    const local = makeRow('coalesced')
    const storage = deferred<(FamilyCapsule | JournalPhoto)[]>()
    const store = createStore()
    store.list.mockReturnValue(storage.promise)
    factory.mockReturnValue(store)
    fetch.mockResolvedValue([local])
    const first = renderHook(() => useSubject('member:family'), { wrapper: StrictMode })
    const second = renderHook(() => useSubject('member:family'))
    expect(store.list).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
    first.unmount()
    await act(async () => { storage.resolve([local]) })
    await waitFor(() => expect(second.result.current.rows).toEqual([local]))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(store.save).not.toHaveBeenCalled()
  })

  it('refreshes stale sessions and still reacts immediately to realtime/online changes', async () => {
    let now = 100_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const store = createStore([makeRow('cached')])
    factory.mockReturnValue(store)
    const first = renderHook(() => useSubject('member:family'))
    await act(async () => { await first.result.current.refresh() })
    first.unmount()
    now += 31_000
    const next = renderHook(() => useSubject('member:family'))
    expect(next.result.current.rows[0].id).toBe('cached')
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await act(async () => { await next.result.current.refresh() })
    const afterMount = fetch.mock.calls.length
    await act(async () => { subscribe.mock.calls.at(-1)?.[0]() })
    expect(fetch).toHaveBeenCalledTimes(afterMount + 1)
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(fetch).toHaveBeenCalledTimes(afterMount + 2)
  })

  it('invalidates pending responses on account reset and never revives departed private data', async () => {
    const oldNetwork = deferred<(FamilyCapsule | JournalPhoto)[]>()
    const oldStore = createStore([makeRow('old-private')])
    const newStore = createStore()
    factory.mockReturnValueOnce(oldStore).mockReturnValue(newStore)
    fetch.mockReturnValueOnce(oldNetwork.promise).mockResolvedValue([])
    const first = renderHook(() => useSubject('old:family'))
    await waitFor(() => expect(first.result.current.rows[0]?.id).toBe('old-private'))
    first.unmount()
    act(() => clearMemberSessionCaches('old:family'))
    const second = renderHook(() => useSubject('new:family'))
    expect(second.result.current.rows).toEqual([])
    await act(async () => { oldNetwork.resolve([makeRow('late-private')]) })
    expect(second.result.current.rows).toEqual([])
    expect(oldStore.save).not.toHaveBeenCalled()
    second.unmount()
    const returning = renderHook(() => useSubject('old:family'))
    expect(returning.result.current.rows).toEqual([])
    await waitFor(() => expect(returning.result.current.loading).toBe(false))
    expect(factory).toHaveBeenCalledTimes(3)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

describe('Archive freshness', () => {
  afterEach(() => {
    cleanup()
    clearMemberSessionCaches()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

it('publishes refreshed archive metadata before slow Blob persistence completes', async () => {
  clearMemberSessionCaches()
  const persistence = deferred<void>()
  const local = capsule('same')
  const remote = { ...local, title: 'Updated title' }
  const store = {
    list: vi.fn(async () => [local]),
    save: vi.fn(() => persistence.promise), remove: vi.fn(),
  }
  mocks.archiveStore.mockReturnValue(store)
  mocks.archiveFetch.mockResolvedValue([remote])
  mocks.archiveSubscribe.mockResolvedValue(() => undefined)
  const view = renderHook(() => useJournalCapsuleArchive({ cacheNamespace: 'member:family' }))
  await waitFor(() => expect(view.result.current.capsules[0]?.title).toBe('Updated title'))
  expect(view.result.current.loading).toBe(false)
  expect(store.save).toHaveBeenCalledTimes(1)
  await act(async () => { persistence.resolve() })
  view.unmount()
  clearMemberSessionCaches()
})

it('refreshes on a scoped offline edit while unmounted, without reacting to another family', async () => {
  const local = capsule('offline')
  const store = { list: vi.fn(async () => [local]), save: vi.fn(), remove: vi.fn() }
  mocks.archiveStore.mockReturnValue(store)
  mocks.archiveFetch.mockReset().mockResolvedValue([])
  mocks.archiveSubscribe.mockResolvedValue(() => undefined)
  const first = renderHook(() => useJournalCapsuleArchive({ cacheNamespace: 'member:family' }))
  await act(async () => { await first.result.current.refresh() })
  first.unmount()
  notifyLocalCapsulesChanged('another:family')
  const second = renderHook(() => useJournalCapsuleArchive({ cacheNamespace: 'member:family' }))
  expect(store.list).toHaveBeenCalledTimes(1)
  second.unmount()
  local.title = 'Added offline'
  notifyLocalCapsulesChanged('member:family')
  const third = renderHook(() => useJournalCapsuleArchive({ cacheNamespace: 'member:family' }))
  await waitFor(() => expect(store.list).toHaveBeenCalledTimes(2))
  expect(third.result.current.capsules[0].title).toBe('Added offline')
})

it('does not lose a local edit arriving while an archive refresh is in flight', async () => {
  const network = deferred<FamilyCapsule[]>()
  const store = { list: vi.fn(async () => [capsule('offline')]), save: vi.fn(), remove: vi.fn() }
  mocks.archiveStore.mockReturnValue(store)
  mocks.archiveFetch.mockReset().mockReturnValueOnce(network.promise).mockResolvedValue([])
  const view = renderHook(() => useJournalCapsuleArchive({ cacheNamespace: 'member:family' }))
  await waitFor(() => expect(mocks.archiveFetch).toHaveBeenCalledTimes(1))
  store.list.mockResolvedValue([capsule('new-offline')])
  act(() => notifyLocalCapsulesChanged('member:family'))
  await act(async () => { network.resolve([]) })
  await waitFor(() => expect(view.result.current.capsules[0]?.id).toBe('new-offline'))
  expect(store.list).toHaveBeenCalledTimes(2)
})

it('revalidates a capsule that unlocked while the tab was hidden inside the warm window', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
  const local = { ...capsule('reveal'), opensAt: '2026-01-02T00:00:10Z' }
  const store = { list: vi.fn(async () => [local]), save: vi.fn(), remove: vi.fn() }
  mocks.archiveStore.mockReturnValue(store)
  mocks.archiveFetch.mockReset().mockResolvedValue([])
  const first = renderHook(() => useJournalCapsuleArchive({ cacheNamespace: 'member:family' }))
  await act(async () => { await first.result.current.refresh() })
  first.unmount()
  vi.setSystemTime(new Date('2026-01-02T00:00:11Z'))
  const second = renderHook(() => useJournalCapsuleArchive({ cacheNamespace: 'member:family' }))
  await waitFor(() => expect(store.list).toHaveBeenCalledTimes(2))
  expect(second.result.current.clock.getTime()).toBe(Date.now())
})
})
