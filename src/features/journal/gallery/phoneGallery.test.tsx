import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMemberSessionCaches } from '../../../app/memberSessionCache'

const mocks = vi.hoisted(() => ({
  native: true, available: true, background: false, backgroundCancel: vi.fn(),
  permission: vi.fn(), request: vi.fn(), revision: vi.fn(), list: vi.fn(), read: vi.fn(), settings: vi.fn(),
  peopleLoad: vi.fn(), peopleSave: vi.fn(), subscribeResume: vi.fn(),
  resume: undefined as (() => void) | undefined,
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => mocks.native, getPlatform: () => 'android',
    isPluginAvailable: (name: string) => name === 'BackgroundGalleryScan' ? mocks.background : mocks.available },
  registerPlugin: (name: string) => name === 'BackgroundGalleryScan' ? { cancel: mocks.backgroundCancel }
    : ({ getPermission: mocks.permission, requestPermission: mocks.request,
    getLibraryRevision: mocks.revision, listPhotos: mocks.list, readPhoto: mocks.read, openSettings: mocks.settings }),
}))
vi.mock('../../../lib/appResume', () => ({
  subscribeToAppResume: (callback: () => void) => {
    mocks.subscribeResume(callback)
    mocks.resume = callback
    return () => { if (mocks.resume === callback) mocks.resume = undefined }
  },
}))
vi.mock('../people/peopleTimelineStore', async (original) => ({
  ...await original<typeof import('../people/peopleTimelineStore')>(),
  loadPeopleTimelineState: mocks.peopleLoad, savePeopleTimelineState: mocks.peopleSave,
}))

import {
  PHONE_GALLERY_CLEARED_EVENT, readGalleryPhotoSource,
  makeGalleryPhotoSource, isGalleryPhotoSource,
} from './phoneGallery'
import type { NativePhoneGalleryPhoto } from './phoneGallery'
import { galleryMetadataKey, loadGalleryMetadata } from './phoneGalleryMetadata'
import { createPhoneGallerySession, usePhoneGallery } from './usePhoneGallery'
import { emptyPeopleTimelineState } from '../people/peopleTimelineStore'
import { getPeopleTimelineSession } from '../people/peopleTimelineSession'

type Session = ReturnType<typeof createPhoneGallerySession>
const sessions: Session[] = []
const jpeg = 'data:image/jpeg;base64,/9j/AA=='
function session(namespace = 'member:family') {
  const value = createPhoneGallerySession(namespace)
  sessions.push(value)
  return value
}
function photo(id: string, extra: Partial<NativePhoneGalleryPhoto> = {}): NativePhoneGalleryPhoto {
  return { id, capturedAt: '2026-09-13T09:00:00.000Z', width: 4000, height: 3000,
    filename: `${id}.jpg`, modifiedAt: '2026-09-13T09:30:00.000Z', ...extra }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { resolve, promise }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.background = false
  mocks.backgroundCancel.mockResolvedValue(undefined)
  localStorage.clear()
  mocks.native = true
  mocks.available = true
  mocks.resume = undefined
  mocks.permission.mockResolvedValue({ status: 'granted' })
  mocks.request.mockResolvedValue({ status: 'granted' })
  mocks.revision.mockResolvedValue({ revision: 'native-v1:initial' })
  mocks.list.mockResolvedValue({ photos: [photo('one')], hasMore: false })
  mocks.read.mockResolvedValue({ dataUrl: jpeg })
  mocks.settings.mockResolvedValue({ opened: true })
  mocks.peopleLoad.mockResolvedValue(emptyPeopleTimelineState())
  mocks.peopleSave.mockResolvedValue(true)
})
afterEach(() => {
  cleanup()
  clearMemberSessionCaches()
  sessions.splice(0).forEach((value) => value.dispose())
  vi.restoreAllMocks()
})

describe('explicit metadata-only phone gallery session', () => {
  it('cancels a cold Android background job when Settings disconnects before Journal mounts', async () => {
    mocks.background = true
    const gallery = session('member:family')
    gallery.disconnect()
    expect(mocks.backgroundCancel).toHaveBeenCalledWith({ scope: 'member:family' })
  })
  it('does not prompt or enumerate until Connect is explicitly invoked', async () => {
    const value = session()
    await value.hydrate()
    await value.refresh()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.permission).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
    await value.connect()
    expect(mocks.request).toHaveBeenCalledOnce()
    expect(value.getSnapshot()).toMatchObject({ enabled: true, ready: true, permission: 'granted', error: null })
  })

  it('persists only whitelisted metadata and keeps stable scoped references', async () => {
    mocks.list.mockResolvedValue({ photos: [{ ...photo('ios/id?one'), dataUrl: jpeg, blob: new Blob(['private']) }], hasMore: false })
    const value = session('first:family')
    await value.connect()
    const result = value.getSnapshot().photos[0]
    expect(result.id).toBe('device-gallery:ios%2Fid%3Fone')
    expect(result.source).toContain('scope=first%3Afamily')
    const stored = localStorage.getItem(galleryMetadataKey('first:family'))!
    expect(stored).not.toContain('dataUrl')
    expect(stored).not.toContain('blob')
    expect(stored).not.toContain('base64')
    expect(stored).not.toContain('source')
    expect(loadGalleryMetadata('first:family').photos).toEqual(value.getSnapshot().photos)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('deduplicates paginated native IDs and advances by the native page size', async () => {
    mocks.list.mockResolvedValueOnce({ photos: [photo('one')], hasMore: true })
      .mockResolvedValueOnce({ photos: [], hasMore: true })
      .mockResolvedValueOnce({ photos: [photo('one'), photo('two')], hasMore: false })
    const value = session()
    await value.connect()
    expect(value.getSnapshot().photos).toHaveLength(2)
    expect(mocks.list.mock.calls.map(([options]) => options.offset)).toEqual([0, 100, 200])
    expect(value.getSnapshot().progress).toBeNull()
  })

  it('keeps the previous complete index on a partial failed refresh', async () => {
    const value = session()
    await value.connect()
    const previous = value.getSnapshot().photos
    mocks.list.mockResolvedValueOnce({ photos: [photo('new')], hasMore: true })
      .mockRejectedValueOnce(new Error('Temporarily unavailable'))
    await value.refresh()
    expect(value.getSnapshot().photos).toBe(previous)
    expect(value.getSnapshot().ready).toBe(true)
    expect(value.getSnapshot().error).toContain('unchanged')
    expect(loadGalleryMetadata('member:family').photos[0].nativeId).toBe('one')
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('limited access refresh replaces only after the entire selected subset succeeds', async () => {
    mocks.request.mockResolvedValue({ status: 'limited' })
    mocks.permission.mockResolvedValue({ status: 'limited' })
    mocks.list.mockResolvedValueOnce({ photos: [photo('one'), photo('two')], hasMore: false })
    const value = session()
    await value.connect()
    const oldSource = value.getSnapshot().photos.find((item) => item.nativeId === 'two')!.source
    mocks.list.mockResolvedValue({ photos: [photo('one')], hasMore: false })
    await value.refresh()
    expect(value.getSnapshot().photos).toHaveLength(1)
    await expect(readGalleryPhotoSource(oldSource)).rejects.toThrow('Connect this account')
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('revoked permission immediately removes references and emits a cache clearing event', async () => {
    const value = session()
    await value.connect()
    const cleared = vi.fn()
    window.addEventListener(PHONE_GALLERY_CLEARED_EVENT, cleared)
    mocks.permission.mockResolvedValue({ status: 'denied' })
    await value.refresh()
    expect(value.getSnapshot()).toMatchObject({ enabled: false, ready: true, permission: 'denied', photos: [] })
    expect(loadGalleryMetadata('member:family')).toMatchObject({ enabled: false, setupComplete: true, photos: [] })
    expect(cleared.mock.calls[0][0].detail).toEqual({ cacheNamespace: 'member:family', reason: 'permission' })
    window.removeEventListener(PHONE_GALLERY_CLEARED_EVENT, cleared)
  })

  it('Disconnect cancels an unfinished enumeration without allowing late results to restore photos', async () => {
    const index = deferred<{ photos: NativePhoneGalleryPhoto[]; hasMore: boolean }>()
    mocks.list.mockReturnValue(index.promise)
    const value = session()
    const pending = value.connect()
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    value.disconnect()
    index.resolve({ photos: [photo('late')], hasMore: false })
    await pending
    expect(value.getSnapshot()).toMatchObject({ enabled: false, photos: [], ready: true })
    expect(loadGalleryMetadata('member:family')).toMatchObject({ enabled: false, setupComplete: true, photos: [] })
  })

  it('account disposal rejects late work but preserves that account’s explicit saved opt-in', async () => {
    const index = deferred<{ photos: NativePhoneGalleryPhoto[]; hasMore: boolean }>()
    mocks.list.mockReturnValue(index.promise)
    const value = session()
    const pending = value.connect()
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
    value.dispose()
    index.resolve({ photos: [photo('late')], hasMore: false })
    await pending
    expect(value.getSnapshot().photos).toEqual([])
    expect(loadGalleryMetadata('member:family').enabled).toBe(true)
    expect(loadGalleryMetadata('member:family').photos).toEqual([])
  })

  it('rehydrates explicit opt-in without prompting, but does not display stale cached rows first', async () => {
    const first = session()
    await first.connect()
    first.dispose()
    const next = session()
    expect(next.getSnapshot().photos).toEqual([])
    expect(next.getSnapshot().ready).toBe(false)
    await next.hydrate()
    expect(next.getSnapshot().photos).toHaveLength(1)
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('browser and unregistered native bridge remain explicit unsupported fallbacks', async () => {
    mocks.native = false
    const browser = session()
    await browser.connect()
    expect(browser.getSnapshot()).toMatchObject({ supported: false, enabled: false, permission: 'unavailable' })
    expect(mocks.request).not.toHaveBeenCalled()
    mocks.native = true
    mocks.available = false
    expect(session('other:family').getSnapshot().supported).toBe(false)
  })

  it('reuses a warm session across routes and refreshes on resume without prompting', async () => {
    const first = renderHook(() => usePhoneGallery('warm:family'))
    await act(async () => { await first.result.current.connect() })
    const photos = first.result.current.photos
    first.unmount()
    const second = renderHook(() => usePhoneGallery('warm:family'))
    expect(second.result.current.photos).toBe(photos)
    expect(mocks.list).toHaveBeenCalledOnce()
    await act(async () => { mocks.resume?.() })
    await waitFor(() => expect(mocks.revision).toHaveBeenCalledTimes(3))
    expect(mocks.list).toHaveBeenCalledOnce()
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('namespace switching hides previous rows and rejects their transient photo reads', async () => {
    const hook = renderHook(({ namespace }) => usePhoneGallery(namespace), { initialProps: { namespace: 'one:family' } })
    await act(async () => { await hook.result.current.connect() })
    const source = hook.result.current.photos[0].source
    hook.rerender({ namespace: 'two:family' })
    expect(hook.result.current.photos).toEqual([])
    expect(hook.result.current.enabled).toBe(false)
    await expect(readGalleryPhotoSource(source)).rejects.toThrow('Connect this account')
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('remembers a skipped setup across launches without any automatic permission prompt', async () => {
    const first = session()
    first.skipSetup()
    expect(first.getSnapshot()).toMatchObject({ setupComplete: true, setupPersisted: true, enabled: false })
    first.dispose()
    const returning = session()
    await returning.hydrate()
    mocks.resume?.()
    expect(returning.getSnapshot()).toMatchObject({ setupComplete: true, enabled: false })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.permission).not.toHaveBeenCalled()
    expect(mocks.revision).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
    await returning.connect()
    expect(returning.getSnapshot()).toMatchObject({ setupComplete: true, enabled: true })
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('remembers a denied choice and a later disconnect instead of asking again on launch', async () => {
    mocks.request.mockResolvedValueOnce({ status: 'denied' })
    const first = session()
    await first.connect()
    expect(first.getSnapshot()).toMatchObject({ enabled: false, setupComplete: true, setupPersisted: true })
    first.dispose()
    const returning = session()
    await returning.hydrate()
    expect(mocks.request).toHaveBeenCalledOnce()
    await returning.connect()
    returning.disconnect()
    returning.dispose()
    expect(session().getSnapshot()).toMatchObject({ enabled: false, setupComplete: true, setupPersisted: true })
  })

  it('migrates a connected v1 cache to completed setup immediately and performs one quiet revision-backed index', async () => {
    localStorage.setItem(galleryMetadataKey('member:family'), JSON.stringify({ version: 1, enabled: true, photos: [photo('old')] }))
    const value = session()
    expect(value.getSnapshot()).toMatchObject({ setupComplete: true, setupPersisted: true, photos: [], ready: false })
    await value.hydrate()
    expect(mocks.list).toHaveBeenCalledOnce()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(loadGalleryMetadata('member:family').revision).toBe('native-v1:initial')
    value.dispose()
    await session().hydrate()
    expect(mocks.list).toHaveBeenCalledOnce()
  })

  it('restores a persisted index only after fresh permission and matching revision, with no photo enumeration', async () => {
    const first = session()
    await first.connect()
    const source = first.getSnapshot().photos[0].source
    first.dispose()
    const revision = deferred<{ revision: string }>()
    mocks.revision.mockReturnValueOnce(revision.promise)
    const value = session()
    const hydration = value.hydrate()
    await waitFor(() => expect(mocks.revision).toHaveBeenCalledTimes(3))
    expect(value.getSnapshot()).toMatchObject({ photos: [], ready: false, setupComplete: true })
    await expect(readGalleryPhotoSource(source)).rejects.toThrow('Connect this account')
    revision.resolve({ revision: 'native-v1:initial' })
    await hydration
    expect(value.getSnapshot()).toMatchObject({ ready: true, photos: [expect.objectContaining({ nativeId: 'one' })] })
    expect(mocks.list).toHaveBeenCalledOnce()
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('quietly refreshes a changed full-access library without removing its live rows or showing indexing progress', async () => {
    const value = session()
    await value.connect()
    const oldPhotos = value.getSnapshot().photos
    const index = deferred<{ photos: NativePhoneGalleryPhoto[]; hasMore: boolean }>()
    mocks.revision.mockResolvedValue({ revision: 'native-v1:changed' })
    mocks.list.mockReturnValueOnce(index.promise)
    mocks.resume?.()
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
    expect(value.getSnapshot().photos).toBe(oldPhotos)
    expect(value.getSnapshot()).toMatchObject({ ready: true, progress: null })
    index.resolve({ photos: [photo('one'), photo('two')], hasMore: false })
    await waitFor(() => expect(value.getSnapshot().photos).toHaveLength(2))
    expect(value.getSnapshot().photos.find((item) => item.nativeId === 'one')!.source).toBe(oldPhotos[0].source)
    expect(loadGalleryMetadata('member:family').revision).toBe('native-v1:changed')
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('never restores cached limited photos after the selected subset changes, even if the count is the same', async () => {
    mocks.request.mockResolvedValue({ status: 'limited' })
    mocks.permission.mockResolvedValue({ status: 'limited' })
    const first = session()
    await first.connect()
    const oldSource = first.getSnapshot().photos[0].source
    first.dispose()
    mocks.revision.mockResolvedValue({ revision: 'native-v1:different-selection' })
    const index = deferred<{ photos: NativePhoneGalleryPhoto[]; hasMore: boolean }>()
    mocks.list.mockReturnValueOnce(index.promise)
    const value = session()
    const hydration = value.hydrate()
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
    expect(value.getSnapshot().photos).toEqual([])
    await expect(readGalleryPhotoSource(oldSource)).rejects.toThrow('Connect this account')
    index.resolve({ photos: [photo('replacement')], hasMore: false })
    await hydration
    expect(value.getSnapshot().photos.map(({ nativeId }) => nativeId)).toEqual(['replacement'])
    expect(mocks.request).toHaveBeenCalledOnce()
  })

  it('hides old full-access references immediately when permission becomes limited and revision verification fails', async () => {
    const value = session()
    await value.connect()
    const oldSource = value.getSnapshot().photos[0].source
    mocks.permission.mockResolvedValue({ status: 'limited' })
    mocks.revision.mockRejectedValueOnce(new Error('Temporarily unavailable'))
    await value.refresh()
    expect(value.getSnapshot()).toMatchObject({ permission: 'limited', photos: [], ready: false })
    await expect(readGalleryPhotoSource(oldSource)).rejects.toThrow('Connect this account')
    expect(mocks.list).toHaveBeenCalledOnce()
  })

  it('does not store a changed-during-enumeration revision or replace the prior complete index', async () => {
    const value = session()
    await value.connect()
    const oldPhotos = value.getSnapshot().photos
    mocks.revision.mockResolvedValueOnce({ revision: 'native-v1:before' }).mockResolvedValueOnce({ revision: 'native-v1:after' })
    mocks.list.mockResolvedValue({ photos: [photo('new')], hasMore: false })
    await value.refresh()
    expect(value.getSnapshot().photos).toBe(oldPhotos)
    expect(value.getSnapshot().error).toContain('unchanged')
    expect(loadGalleryMetadata('member:family').revision).toBe('native-v1:initial')
    mocks.revision.mockResolvedValue({ revision: 'native-v1:after' })
    await value.refresh()
    expect(loadGalleryMetadata('member:family').revision).toBe('native-v1:after')
    expect(value.getSnapshot().photos.map(({ nativeId }) => nativeId)).toEqual(['new'])
  })

  it('preserves the old complete index when native revision detection reports a concurrent mutation', async () => {
    const value = session()
    await value.connect()
    const previous = value.getSnapshot().photos
    mocks.revision.mockRejectedValueOnce({ code: 'LIBRARY_CHANGED' })
    await value.refresh()
    expect(value.getSnapshot().photos).toBe(previous)
    expect(mocks.list).toHaveBeenCalledOnce()
    expect(loadGalleryMetadata('member:family').revision).toBe('native-v1:initial')
  })

  it('coalesces resume bursts across multiple mounted consumers and retains one persistent lifecycle subscription', async () => {
    const first = renderHook(() => usePhoneGallery('warm:family'))
    const second = renderHook(() => usePhoneGallery('warm:family'))
    await act(async () => { await first.result.current.connect() })
    expect(mocks.subscribeResume).toHaveBeenCalledOnce()
    const revision = deferred<{ revision: string }>()
    mocks.revision.mockReturnValueOnce(revision.promise)
    await act(async () => { mocks.resume?.(); mocks.resume?.(); mocks.resume?.() })
    expect(mocks.revision).toHaveBeenCalledTimes(3)
    first.unmount()
    second.unmount()
    expect(mocks.resume).toBeDefined()
    revision.resolve({ revision: 'native-v1:initial' })
    await act(async () => { await revision.promise })
    expect(mocks.list).toHaveBeenCalledOnce()
    clearMemberSessionCaches('warm:family')
    expect(mocks.resume).toBeUndefined()
  })

  it('remembers choice when an oversized metadata index exceeds storage quota, without marking the empty fallback complete', async () => {
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (JSON.parse(value).photos?.length) throw new Error('Quota exceeded')
      original.call(this, key, value)
    })
    const value = session()
    await value.connect()
    expect(value.getSnapshot()).toMatchObject({ setupComplete: true, setupPersisted: true, photos: [expect.anything()] })
    expect(value.getSnapshot().error).toContain('index could not be saved')
    expect(loadGalleryMetadata('member:family')).toMatchObject({ enabled: true, setupComplete: true, photos: [] })
    expect(loadGalleryMetadata('member:family').revision).toBeUndefined()
    value.dispose()
    await session().hydrate()
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })

  it('reports disabled persistence honestly while keeping a skipped choice for the current session', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled') })
    const value = session()
    value.skipSetup()
    expect(value.getSnapshot()).toMatchObject({ setupComplete: true, setupPersisted: false, enabled: false })
    expect(value.getSnapshot().error).toContain('could not remember')
    expect(mocks.request).not.toHaveBeenCalled()
    expect(localStorage.getItem(galleryMetadataKey('member:family'))).toBeNull()
  })

  it('removes an obsolete saved opt-in if persisting a disconnect fails', async () => {
    const value = session()
    await value.connect()
    expect(loadGalleryMetadata('member:family').enabled).toBe(true)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage is full') })
    value.disconnect()
    expect(value.getSnapshot()).toMatchObject({ enabled: false, setupComplete: true, setupPersisted: false })
    expect(loadGalleryMetadata('member:family').enabled).toBe(false)
    expect(localStorage.getItem(galleryMetadataKey('member:family'))).toBeNull()
  })

  it('does not trust a supposedly complete cache containing invalid or duplicate metadata rows', async () => {
    localStorage.setItem(galleryMetadataKey('member:family'), JSON.stringify({
      version: 2, enabled: true, setupComplete: true, indexComplete: true,
      revision: 'native-v1:initial', permission: 'granted', photos: [photo('one'), photo('one'), photo('bad', { width: 0 })],
    }))
    const value = session()
    expect(value.getSnapshot().setupComplete).toBe(true)
    expect(loadGalleryMetadata('member:family').revision).toBeUndefined()
    await value.hydrate()
    expect(mocks.list).toHaveBeenCalledOnce()
  })

  it('disconnects and durably prunes gallery matches from Settings without a mounted Journal or scan job', async () => {
    const stored = emptyPeopleTimelineState()
    const galleryKey = 'journal-photo:device-gallery:one'
    stored.people = [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }]
    stored.faceScans = { [galleryKey]: { scannedAt: '2026-09-13', faces: [] }, ordinary: { scannedAt: '2026-09-13', faces: [] } }
    stored.faceProfiles.maya = { references: [
      { id: 'portrait', source: 'enrollment', createdAt: '2026-09-13', embedding: [1] },
      { id: 'supplemental', source: 'manual-photo', createdAt: '2026-09-13', embedding: [1], photoKey: galleryKey },
    ] }
    mocks.peopleLoad.mockResolvedValue(stored)
    const value = session()
    value.disconnect()
    await waitFor(() => expect(mocks.peopleSave).toHaveBeenCalledOnce())
    const saved = mocks.peopleSave.mock.calls[0][1]
    expect(Object.keys(saved.faceScans)).toEqual(['ordinary'])
    expect(saved.faceProfiles.maya.references.map(({ id }: { id: string }) => id)).toEqual(['portrait'])
    expect(saved.people).toEqual(stored.people)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('does not let delayed privacy cleanup from a departed namespace recreate or evict the current account session', async () => {
    const departed = deferred<ReturnType<typeof emptyPeopleTimelineState>>()
    mocks.peopleLoad.mockReturnValueOnce(departed.promise).mockResolvedValue(emptyPeopleTimelineState())
    const hook = renderHook(({ namespace }) => usePhoneGallery(namespace), { initialProps: { namespace: 'old:family' } })
    act(() => { hook.result.current.skipSetup() })
    hook.rerender({ namespace: 'current:family' })
    const current = getPeopleTimelineSession('current:family')
    await current.hydrate()
    departed.resolve(emptyPeopleTimelineState())
    await act(async () => { await departed.promise })
    expect(getPeopleTimelineSession('current:family')).toBe(current)
    expect(current.getSnapshot().ready).toBe(true)
    expect(mocks.peopleSave).not.toHaveBeenCalled()
  })
})

describe('transient guarded phone photo reads', () => {
  it('requires a connected scoped reference and rejects arbitrary URLs', async () => {
    await expect(readGalleryPhotoSource('https://example.com/photo.jpg')).rejects.toThrow('Invalid')
    await expect(readGalleryPhotoSource('bubble-gallery:one')).rejects.toThrow('Invalid')
    await expect(readGalleryPhotoSource(makeGalleryPhotoSource('one', 'member:family'))).rejects.toThrow('Connect this account')
    expect(isGalleryPhotoSource('bubble-gallery:one')).toBe(true)
    expect(isGalleryPhotoSource(new Blob())).toBe(false)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('clamps native decode size, caches only in memory, and checks permission again on a cache hit', async () => {
    const value = session()
    await value.connect()
    const source = value.getSnapshot().photos[0].source
    expect(await readGalleryPhotoSource(source, 8000)).toBe(jpeg)
    expect(mocks.read).toHaveBeenCalledWith({ id: 'one', maxDimension: 1600 })
    expect(await readGalleryPhotoSource(source, 1600)).toBe(jpeg)
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(localStorage.getItem(galleryMetadataKey('member:family'))).not.toContain('base64')
    mocks.permission.mockResolvedValue({ status: 'denied' })
    await expect(readGalleryPhotoSource(source, 1600)).rejects.toThrow('permission')
    expect(value.getSnapshot().photos).toEqual([])
  })

  it('late in-flight photo decoding cannot escape a disconnect boundary', async () => {
    const value = session()
    await value.connect()
    const source = value.getSnapshot().photos[0].source
    const decoded = deferred<{ dataUrl: string }>()
    mocks.read.mockReturnValue(decoded.promise)
    const read = readGalleryPhotoSource(source)
    await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
    value.disconnect()
    decoded.resolve({ dataUrl: jpeg })
    await expect(read).rejects.toThrow('Connect this account')
  })

  it('revalidates individual limited-access assets even when a preview was cached', async () => {
    mocks.request.mockResolvedValue({ status: 'limited' })
    mocks.permission.mockResolvedValue({ status: 'limited' })
    const value = session()
    await value.connect()
    const source = value.getSnapshot().photos[0].source
    await readGalleryPhotoSource(source)
    mocks.read.mockRejectedValue({ code: 'PHOTO_UNAVAILABLE' })
    await expect(readGalleryPhotoSource(source)).rejects.toMatchObject({ code: 'PHOTO_UNAVAILABLE' })
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed decoded image payloads instead of caching them', async () => {
    const value = session()
    await value.connect()
    mocks.read.mockResolvedValue({ dataUrl: 'file:///private/photo.jpg' })
    await expect(readGalleryPhotoSource(value.getSnapshot().photos[0].source)).rejects.toThrow('invalid photo preview')
  })

  it('bounded LRU evicts an older preview instead of retaining an entire library', async () => {
    mocks.list.mockResolvedValue({ photos: Array.from({ length: 25 }, (_, index) => photo(String(index))), hasMore: false })
    const value = session()
    await value.connect()
    for (const item of value.getSnapshot().photos) await readGalleryPhotoSource(item.source, 320)
    await readGalleryPhotoSource(value.getSnapshot().photos[0].source, 320)
    expect(mocks.read).toHaveBeenCalledTimes(26)
  })
})
