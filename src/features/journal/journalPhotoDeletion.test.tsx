import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMemberSessionCaches } from '../../app/memberSessionCache'
import type { JournalPhoto, JournalPhotoStore } from './journalPhotoTypes'

const mocks = vi.hoisted(() => ({
  createStore: vi.fn(), fetch: vi.fn(), upload: vi.fn(), subscribe: vi.fn(),
  remove: vi.fn(), deleted: vi.fn(), subscribeDeletions: vi.fn(),
}))

vi.mock('./journalPhotoStore', () => ({ createDefaultJournalPhotoStore: mocks.createStore }))
vi.mock('./journalPhotoService', () => ({
  fetchFamilyJournalPhotos: mocks.fetch, uploadFamilyJournalPhoto: mocks.upload,
  subscribeToFamilyJournalPhotos: mocks.subscribe,
}))
vi.mock('./journalPhotoDeletionService', () => ({
  deleteFamilyJournalPhoto: mocks.remove, fetchDeletedJournalPhotos: mocks.deleted,
  subscribeToJournalPhotoDeletions: mocks.subscribeDeletions,
}))
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })) },
}))

import { useJournalPhotoLibrary } from './journalPhotoLibrary'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

const ownPhoto: JournalPhoto = {
  id: '11111111-1111-4111-8111-111111111111',
  image: new Blob(['photo']), thumbnail: new Blob(['thumbnail']), width: 900, height: 1200,
  thumbnailWidth: 300, thumbnailHeight: 400, caption: 'Family picnic',
  capturedAt: '2026-09-01T10:00:00.000Z', contributorName: 'Simreen',
  ownedByCurrentUser: true, syncStatus: 'synced',
}
const selfDeletion = {
  photoId: ownPhoto.id,
  uploaderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ownedByCurrentUser: true,
}

function memoryStore(seed: JournalPhoto[]) {
  const records = new Map(seed.map((photo) => [photo.id, photo]))
  const store = {
    list: vi.fn(async () => [...records.values()]),
    save: vi.fn(async (photo: JournalPhoto) => { records.set(photo.id, photo) }),
    remove: vi.fn(async (id: string) => { records.delete(id) }),
  } satisfies JournalPhotoStore
  return { store, records }
}

beforeEach(() => {
  clearMemberSessionCaches()
  vi.resetAllMocks()
  mocks.fetch.mockResolvedValue([])
  mocks.upload.mockResolvedValue(null)
  mocks.subscribe.mockResolvedValue(() => undefined)
  mocks.remove.mockResolvedValue(undefined)
  mocks.deleted.mockResolvedValue([])
  mocks.subscribeDeletions.mockResolvedValue(() => undefined)
})

afterEach(() => { cleanup(); clearMemberSessionCaches() })

describe('Journal photo deletion', () => {
  it('rejects another member’s photo before any deletion request', async () => {
    const { store } = memoryStore([{ ...ownPhoto, ownedByCurrentUser: false }])
    mocks.createStore.mockReturnValue(store)
    const hook = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:family' }))
    await waitFor(() => expect(hook.result.current.photos).toHaveLength(1))
    await expect(hook.result.current.deletePhoto(ownPhoto.id)).rejects.toThrow('Only your own')
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('coalesces two deletes and removes only the exact owned photo after server success', async () => {
    const otherPhoto = { ...ownPhoto, id: '22222222-2222-4222-8222-222222222222', ownedByCurrentUser: false }
    const { store } = memoryStore([ownPhoto, otherPhoto])
    const server = deferred<void>()
    mocks.createStore.mockReturnValue(store)
    mocks.remove.mockReturnValue(server.promise)
    const hook = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:family' }))
    await waitFor(() => expect(hook.result.current.photos).toHaveLength(2))
    const first = hook.result.current.deletePhoto(ownPhoto.id)
    const second = hook.result.current.deletePhoto(ownPhoto.id)
    expect(first).toBe(second)
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(ownPhoto.id, 'owner:family'))
    expect(hook.result.current.photos).toHaveLength(2)
    await act(async () => { server.resolve(); await first })
    expect(hook.result.current.photos.map(({ id }) => id)).toEqual([otherPhoto.id])
    expect(store.remove).toHaveBeenCalledExactlyOnceWith(ownPhoto.id)
  })

  it('retains the original photo and durable bytes when the server rejects deletion', async () => {
    const { store, records } = memoryStore([ownPhoto])
    mocks.createStore.mockReturnValue(store)
    mocks.remove.mockRejectedValue(new Error('offline'))
    const hook = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:family' }))
    await waitFor(() => expect(hook.result.current.photos).toHaveLength(1))
    await act(async () => { await expect(hook.result.current.deletePhoto(ownPhoto.id)).rejects.toThrow('offline') })
    expect(hook.result.current.photos).toEqual([ownPhoto])
    expect(records.get(ownPhoto.id)?.image).toBe(ownPhoto.image)
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('does not resurrect a deleted photo from an older in-flight family response', async () => {
    const { store } = memoryStore([ownPhoto])
    mocks.createStore.mockReturnValue(store)
    const network = deferred<JournalPhoto[]>()
    mocks.fetch.mockReturnValue(network.promise)
    const hook = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:family' }))
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce())
    await act(async () => { await hook.result.current.deletePhoto(ownPhoto.id) })
    await act(async () => { network.resolve([ownPhoto]) })
    expect(hook.result.current.photos).toHaveLength(0)
    expect(await store.list()).toHaveLength(0)
  })

  it('shares the pending upload across a tab remount and waits for it before deleting', async () => {
    const { store } = memoryStore([{ ...ownPhoto, syncStatus: 'pending' }])
    const upload = deferred<string | null>()
    mocks.createStore.mockReturnValue(store)
    mocks.upload.mockReturnValue(upload.promise)
    const first = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:family' }))
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce())
    first.unmount()
    const next = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:family' }))
    await act(async () => { await Promise.resolve() })
    expect(mocks.upload).toHaveBeenCalledOnce()
    const deletion = next.result.current.deletePhoto(ownPhoto.id)
    await act(async () => { await Promise.resolve() })
    expect(mocks.remove).not.toHaveBeenCalled()
    await act(async () => { upload.resolve(ownPhoto.id); await deletion })
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(store.save).not.toHaveBeenCalled()
    expect(next.result.current.photos).toHaveLength(0)
    expect(await store.list()).toHaveLength(0)
  })

  it('waits for the acknowledged upload’s durable save before removing the same ID', async () => {
    const { store, records } = memoryStore([{ ...ownPhoto, syncStatus: 'pending' }])
    const saving = deferred<void>()
    store.save.mockImplementation(async (photo) => { await saving.promise; records.set(photo.id, photo) })
    mocks.createStore.mockReturnValue(store)
    mocks.upload.mockResolvedValue(ownPhoto.id)
    const hook = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:family' }))
    await waitFor(() => expect(store.save).toHaveBeenCalledOnce())
    const deletion = hook.result.current.deletePhoto(ownPhoto.id)
    await act(async () => { await Promise.resolve() })
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(store.remove).not.toHaveBeenCalled()
    await act(async () => { saving.resolve(); await deletion })
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(hook.result.current.photos).toHaveLength(0)
    expect(await store.list()).toHaveLength(0)
  })

  it('re-reads tombstones when a deletion hint arrives after the current pass already read them', async () => {
    const { store } = memoryStore([ownPhoto])
    mocks.createStore.mockReturnValue(store)
    const network = deferred<JournalPhoto[]>()
    mocks.fetch.mockReturnValueOnce(network.promise).mockResolvedValue([])
    const hook = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:family' }))
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce())
    expect(mocks.deleted).toHaveBeenCalledOnce()
    mocks.deleted.mockResolvedValue([selfDeletion])
    await act(async () => { mocks.subscribeDeletions.mock.calls[0][0]() })
    expect(mocks.deleted).toHaveBeenCalledOnce()
    await act(async () => { network.resolve([]) })
    await waitFor(() => expect(mocks.deleted).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(hook.result.current.photos).toHaveLength(0))
    expect(store.remove).toHaveBeenCalledWith(ownPhoto.id)
  })

  it('does not send an old-family deletion after an account change while upload completion is pending', async () => {
    const original = memoryStore([{ ...ownPhoto, syncStatus: 'pending' }])
    const other = memoryStore([])
    const upload = deferred<string | null>()
    mocks.createStore.mockImplementation((namespace: string) => namespace === 'owner:family' ? original.store : other.store)
    mocks.upload.mockReturnValue(upload.promise)
    const hook = renderHook(({ namespace }) => useJournalPhotoLibrary({ cacheNamespace: namespace }), { initialProps: { namespace: 'owner:family' } })
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce())
    const deletion = hook.result.current.deletePhoto(ownPhoto.id)
    const rejection = expect(deletion).rejects.toThrow('active family changed')
    hook.rerender({ namespace: 'other:family' })
    await act(async () => { upload.resolve(ownPhoto.id); await rejection })
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(other.store.remove).not.toHaveBeenCalled()
    expect(hook.result.current.photos).toHaveLength(0)
  })

  it('removes a legacy self-owned pending cancellation without hiding a different uploader’s same-ID photo', async () => {
    const { store } = memoryStore([{ ...ownPhoto, syncStatus: 'pending' }])
    const otherPhoto = {
      ...ownPhoto, uploaderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ownedByCurrentUser: false, contributorName: 'Mum',
      image: 'https://family.example/mums-photo.jpg',
      thumbnail: 'https://family.example/mums-thumb.jpg',
    }
    mocks.createStore.mockReturnValue(store)
    mocks.deleted.mockResolvedValue([selfDeletion])
    mocks.fetch.mockResolvedValue([otherPhoto])
    const hook = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:family' }))
    await act(async () => { await hook.result.current.refresh() })
    expect(store.remove).toHaveBeenCalledWith(ownPhoto.id)
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(hook.result.current.photos).toEqual([otherPhoto])
  })

  it('does not prune a cached family member’s photo for another uploader’s matching-ID marker', async () => {
    const otherPhoto = {
      ...ownPhoto, uploaderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ownedByCurrentUser: false, contributorName: 'Mum',
    }
    const { store } = memoryStore([otherPhoto])
    mocks.createStore.mockReturnValue(store)
    mocks.deleted.mockResolvedValue([selfDeletion])
    const hook = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:family' }))
    await act(async () => { await hook.result.current.refresh() })
    expect(hook.result.current.photos).toEqual([otherPhoto])
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('still prunes a relative’s durable cached photo for that exact uploader’s published deletion', async () => {
    const uploaderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const { store } = memoryStore([{ ...ownPhoto, uploaderId, ownedByCurrentUser: false }])
    mocks.createStore.mockReturnValue(store)
    mocks.deleted.mockResolvedValue([{ photoId: ownPhoto.id, uploaderId, ownedByCurrentUser: false }])
    const hook = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:family' }))
    await act(async () => { await hook.result.current.refresh() })
    expect(hook.result.current.photos).toHaveLength(0)
    expect(store.remove).toHaveBeenCalledWith(ownPhoto.id)
  })

  it('a locally confirmed self-deletion does not poison a later family member’s same-ID photo', async () => {
    const { store } = memoryStore([ownPhoto])
    mocks.createStore.mockReturnValue(store)
    const hook = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:family' }))
    await act(async () => { await hook.result.current.refresh() })
    await act(async () => { await hook.result.current.deletePhoto(ownPhoto.id) })
    expect(hook.result.current.photos).toHaveLength(0)
    const otherPhoto = {
      ...ownPhoto, uploaderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ownedByCurrentUser: false, contributorName: 'Mum',
      image: 'https://family.example/later-photo.jpg',
      thumbnail: 'https://family.example/later-thumb.jpg',
    }
    mocks.deleted.mockResolvedValue([selfDeletion])
    mocks.fetch.mockResolvedValue([otherPhoto])
    await act(async () => { await hook.result.current.refresh() })
    expect(hook.result.current.photos).toEqual([otherPhoto])
  })

  it('does not report successful local-only deletion when durable removal fails', async () => {
    const { store } = memoryStore([ownPhoto])
    store.remove.mockRejectedValue(new Error('storage unavailable'))
    mocks.createStore.mockReturnValue(store)
    const hook = renderHook(() => useJournalPhotoLibrary({ cacheNamespace: 'owner:no-family' }))
    await waitFor(() => expect(hook.result.current.photos).toHaveLength(1))
    await act(async () => { await expect(hook.result.current.deletePhoto(ownPhoto.id)).rejects.toThrow('storage unavailable') })
    expect(hook.result.current.photos).toEqual([ownPhoto])
  })
})
