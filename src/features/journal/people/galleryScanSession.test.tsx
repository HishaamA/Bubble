import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMemberSessionCaches } from '../../../app/memberSessionCache'
import { PHONE_GALLERY_CLEARED_EVENT } from '../gallery/phoneGallery'
import { createGalleryScanSession, getGalleryScanSession, useGalleryScanSession } from './galleryScanSession'
import { getPeopleTimelineSession } from './peopleTimelineSession'
import { emptyPeopleTimelineState } from './peopleTimelineStore'
import type { FaceScanCheckpoint } from './faceRecognition'
import type { PeopleTimelinePhoto, PeopleTimelineState, StoredPhotoFaceScan } from './types'

const mocks = vi.hoisted(() => ({
  scan: vi.fn(), load: vi.fn(), save: vi.fn(), getState: vi.fn(),
  authorized: new Set<string>(),
  appListeners: new Set<(state: { isActive: boolean }) => void>(),
}))

vi.mock('@capacitor/app', () => ({ App: {
  getState: mocks.getState,
  addListener: vi.fn(async (_name: string, callback: (state: { isActive: boolean }) => void) => {
    mocks.appListeners.add(callback)
    return { remove: async () => { mocks.appListeners.delete(callback) } }
  }),
} }))
vi.mock('../gallery/phoneGallery', () => ({
  PHONE_GALLERY_CLEARED_EVENT: 'bubble:phone-gallery-cleared',
  isGalleryPhotoAuthorized: (source: unknown) => typeof source === 'string' && mocks.authorized.has(source),
}))
vi.mock('./faceRecognition', () => ({ scanTimelineFaces: mocks.scan }))
vi.mock('./peopleTimelineStore', async (original) => ({
  ...await original<typeof import('./peopleTimelineStore')>(),
  loadPeopleTimelineState: mocks.load,
  savePeopleTimelineState: mocks.save,
}))

const NAMESPACE = 'member:family'
const jobs: ReturnType<typeof createGalleryScanSession>[] = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function enrolledState(): PeopleTimelineState {
  return {
    ...emptyPeopleTimelineState(),
    people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01T00:00:00Z' }],
    faceProfiles: { maya: { references: [{ id: 'reference', source: 'enrollment',
      createdAt: '2026-01-01T00:00:00Z', embedding: [1, 0] }] } },
  }
}
function photo(index: number, overrides: Partial<PeopleTimelinePhoto> = {}): PeopleTimelinePhoto {
  const id = `device-gallery:${index}`
  const source = `bubble-gallery:${index}?scope=${NAMESPACE}`
  mocks.authorized.add(source)
  return { key: `journal-photo:${id}`, id, kind: 'journal-photo', origin: 'device-gallery',
    source, scanSource: source, capturedAt: new Date(Date.UTC(2020, 0, index)).toISOString(),
    caption: '', contributorName: '', capsuleId: '', memoryId: '', canScanFaces: true, ...overrides }
}
function faceScan(): StoredPhotoFaceScan { return { scannedAt: '2026-09-13T00:00:00Z', faces: [] } }
function success(photos: PeopleTimelinePhoto[], callback?: (value: FaceScanCheckpoint) => void) {
  const faceScans: Record<string, StoredPhotoFaceScan> = {}
  photos.forEach((item, index) => {
    const scan = faceScan()
    faceScans[item.key] = scan
    callback?.({ photoKey: item.key, faceScan: scan, failed: false, completed: index + 1, total: photos.length })
  })
  return { faceScans, completedPhotoCount: photos.length, failedPhotoCount: 0 }
}
function create(photos: PeopleTimelinePhoto[]) {
  const job = createGalleryScanSession(NAMESPACE)
  jobs.push(job)
  job.updatePhotos(photos)
  return job
}
function clearGallery(reason: 'permission' | 'disconnect' | 'account' | 'refresh', namespace = NAMESPACE) {
  window.dispatchEvent(new CustomEvent(PHONE_GALLERY_CLEARED_EVENT, { detail: { cacheNamespace: namespace, reason } }))
}
function appActive(isActive: boolean) { mocks.appListeners.forEach((callback) => callback({ isActive })) }
async function settled(job: ReturnType<typeof createGalleryScanSession>, status = 'complete') {
  await waitFor(() => expect(job.getSnapshot().status).toBe(status))
}

beforeEach(() => {
  clearMemberSessionCaches()
  vi.clearAllMocks()
  mocks.authorized.clear()
  mocks.appListeners.clear()
  mocks.getState.mockResolvedValue({ isActive: true })
  mocks.load.mockResolvedValue(enrolledState())
  mocks.save.mockResolvedValue(true)
  mocks.scan.mockImplementation(async (photos: PeopleTimelinePhoto[], callback?: (value: FaceScanCheckpoint) => void) => success(photos, callback))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => {
  cleanup()
  jobs.splice(0).forEach((job) => job.dispose())
  clearMemberSessionCaches()
  vi.restoreAllMocks()
})

describe('persistent device gallery face scan job', () => {
  it('scans the entire authorized library oldest first in bounded durable batches, skipping saved scans', async () => {
    const photos = Array.from({ length: 19 }, (_, index) => photo(index + 1))
    const existing = enrolledState()
    existing.faceScans[photos[0].key] = faceScan()
    mocks.load.mockResolvedValue(existing)
    const unapproved = photo(30)
    mocks.authorized.delete(unapproved.scanSource as string)
    const job = create([...photos].reverse().concat([
      photos[4], unapproved, photo(31, { origin: undefined }), photo(32, { canScanFaces: false }),
    ]))
    await settled(job)
    expect(job.getSnapshot()).toMatchObject({ total: 19, scanned: 19, pending: 0, failed: 0 })
    expect(mocks.scan.mock.calls.map(([batch]) => batch.length)).toEqual([8, 8, 2])
    expect(mocks.scan.mock.calls.flatMap(([batch]) => batch.map((item: PeopleTimelinePhoto) => item.key)))
      .toEqual(photos.slice(1).map(({ key }) => key))
    expect(mocks.save).toHaveBeenCalledTimes(3)
    expect(Object.keys(getPeopleTimelineSession(NAMESPACE).getSnapshot().state.faceScans)).toHaveLength(19)
  })

  it('waits for enrollment and reuses successful embeddings when another person is added', async () => {
    const initial = enrolledState()
    initial.faceProfiles = {}
    mocks.load.mockResolvedValue(initial)
    const job = create([photo(1)])
    await settled(job, 'waiting-for-person')
    expect(mocks.scan).not.toHaveBeenCalled()
    const people = getPeopleTimelineSession(NAMESPACE)
    people.replace({ ...people.getSnapshot().state, faceProfiles: enrolledState().faceProfiles })
    await settled(job)
    people.replace({ ...people.getSnapshot().state,
      people: [...people.getSnapshot().state.people, { id: 'sam', name: 'Sam', createdAt: '2026-01-01T00:00:00Z' }],
      faceProfiles: { ...people.getSnapshot().state.faceProfiles, sam: enrolledState().faceProfiles.maya },
    })
    expect(mocks.scan).toHaveBeenCalledTimes(1)
  })

  it('retries transient per-photo failures only twice, leaves a visible failure and supports explicit retry', async () => {
    const photos = [photo(1), photo(2)]
    let fail = true
    mocks.scan.mockImplementation(async (batch: PeopleTimelinePhoto[], callback: (value: FaceScanCheckpoint) => void) => {
      const accepted = batch.filter((item) => item.key !== photos[1].key || !fail)
      const result = success(accepted, callback)
      if (accepted.length !== batch.length) callback({ photoKey: photos[1].key, failed: true, completed: 1, total: batch.length })
      return result
    })
    const job = create(photos)
    await settled(job, 'needs-retry')
    expect(job.getSnapshot()).toMatchObject({ total: 2, scanned: 1, failed: 1, pending: 0 })
    expect(mocks.scan.mock.calls.flatMap(([batch]) => batch).filter((item) => item.key === photos[1].key)).toHaveLength(3)
    fail = false
    job.retry()
    await settled(job)
    expect(job.getSnapshot().scanned).toBe(2)
    expect(mocks.scan.mock.calls.flatMap(([batch]) => batch).filter((item) => item.key === photos[0].key)).toHaveLength(1)
  })

  it('stops a fatal runtime once while durably preserving completed checkpoints', async () => {
    mocks.scan.mockImplementationOnce(async (batch: PeopleTimelinePhoto[], callback: (value: FaceScanCheckpoint) => void) => {
      success(batch.slice(0, 1), callback)
      throw Object.assign(new Error('Close and reopen the app to restart face matching.'), { requiresRestart: true })
    })
    const job = create([photo(1), photo(2)])
    await settled(job, 'needs-retry')
    await waitFor(() => expect(job.getSnapshot().scanned).toBe(1))
    expect(job.getSnapshot()).toMatchObject({ pending: 1, requiresRestart: true, error: expect.stringContaining('reopen') })
    job.retry()
    expect(mocks.scan).toHaveBeenCalledTimes(1)
    expect(mocks.save).toHaveBeenCalledTimes(1)
  })

  it('pauses an active scan immediately and rejects late checkpoints, then resumes unfinished work', async () => {
    const pending = deferred<ReturnType<typeof success>>()
    let callback!: (value: FaceScanCheckpoint) => void
    let signal!: AbortSignal
    mocks.scan.mockImplementationOnce((_batch, checkpoint, cancellation) => {
      callback = checkpoint; signal = cancellation; return pending.promise
    })
    const photos = [photo(1)]
    const job = create(photos)
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledTimes(1))
    job.pause()
    expect(signal.aborted).toBe(true)
    expect(job.getSnapshot()).toMatchObject({ status: 'paused', pauseReason: 'manual' })
    pending.resolve(success(photos, callback))
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledTimes(1))
    expect(mocks.save).not.toHaveBeenCalled()
    job.resume()
    await settled(job)
    expect(mocks.scan).toHaveBeenCalledTimes(2)
    expect(mocks.save).toHaveBeenCalledTimes(1)
  })

  it('keeps editor holds independent from manual pause and other editors', async () => {
    const job = create([photo(1)])
    const first = Symbol('first'), second = Symbol('second')
    job.setHold(first, true)
    job.setHold(second, true)
    await settled(job, 'paused')
    expect(job.getSnapshot().pauseReason).toBe('editor')
    job.pause()
    job.setHold(first, false)
    job.setHold(second, false)
    expect(job.getSnapshot().pauseReason).toBe('manual')
    expect(mocks.scan).not.toHaveBeenCalled()
    job.resume()
    await settled(job)
  })

  it('waits for foreground app state and resumes after native and document suspension', async () => {
    mocks.getState.mockResolvedValue({ isActive: false })
    const job = create([photo(1)])
    await settled(job, 'paused')
    expect(job.getSnapshot().pauseReason).toBe('background')
    expect(mocks.scan).not.toHaveBeenCalled()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    appActive(true)
    expect(mocks.scan).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await settled(job)
  })

  it('survives hook unmount without duplicating the job or re-reading metadata', async () => {
    const pending = deferred<ReturnType<typeof success>>()
    let callback!: (value: FaceScanCheckpoint) => void
    mocks.scan.mockImplementationOnce((_batch, checkpoint) => { callback = checkpoint; return pending.promise })
    const photos = [photo(1)]
    const view = renderHook(() => useGalleryScanSession(NAMESPACE, photos))
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledTimes(1))
    view.unmount()
    pending.resolve(success(photos, callback))
    await settled(getGalleryScanSession(NAMESPACE))
    const returning = renderHook(() => useGalleryScanSession(NAMESPACE))
    expect(returning.result.current.scanned).toBe(1)
    expect(mocks.load).toHaveBeenCalledTimes(1)
    expect(mocks.scan).toHaveBeenCalledTimes(1)
  })

  it('aborts account departure and never writes or restores late private callbacks', async () => {
    const pending = deferred<ReturnType<typeof success>>()
    let callback!: (value: FaceScanCheckpoint) => void
    let signal!: AbortSignal
    mocks.scan.mockImplementationOnce((_batch, checkpoint, cancellation) => {
      callback = checkpoint; signal = cancellation; return pending.promise
    })
    const photos = [photo(1)]
    const view = renderHook(() => useGalleryScanSession(NAMESPACE, photos))
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledTimes(1))
    act(() => { clearMemberSessionCaches(NAMESPACE) })
    expect(signal.aborted).toBe(true)
    pending.resolve(success(photos, callback))
    await act(async () => { await pending.promise })
    expect(view.result.current.total).toBe(0)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('updates an interrupted queue when a photo is removed and another is added', async () => {
    const pending = deferred<ReturnType<typeof success>>()
    let callback!: (value: FaceScanCheckpoint) => void
    let signal!: AbortSignal
    mocks.scan.mockImplementationOnce((_batch, checkpoint, cancellation) => {
      callback = checkpoint; signal = cancellation; return pending.promise
    })
    const first = photo(1), second = photo(2), added = photo(3)
    const job = create([first, second])
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledTimes(1))
    job.updatePhotos([second, added])
    expect(signal.aborted).toBe(true)
    pending.resolve(success([first, second], callback))
    await settled(job)
    expect(job.getSnapshot()).toMatchObject({ total: 2, scanned: 2 })
    expect(Object.keys(getPeopleTimelineSession(NAMESPACE).getSnapshot().state.faceScans)).toEqual([second.key, added.key])
  })

  it.each(['permission', 'disconnect'] as const)('prunes linked metadata on %s without a mounted Journal', async (reason) => {
    const gallery = photo(1)
    const initial = enrolledState()
    initial.faceScans = { [gallery.key]: faceScan(), ordinary: faceScan() }
    initial.assignments = [gallery.key, 'ordinary'].map((photoKey) => ({ photoKey, personId: 'maya', source: 'manual', confirmedAt: '2026-09-13' }))
    initial.faceProfiles.maya.references.push({ id: 'linked', source: 'manual-photo', embedding: [1, 0], createdAt: '2026-09-13', photoKey: gallery.key })
    mocks.load.mockResolvedValue(initial)
    const job = create([gallery])
    await settled(job)
    clearGallery(reason)
    const people = getPeopleTimelineSession(NAMESPACE)
    expect(job.getSnapshot().total).toBe(0)
    expect(Object.keys(people.getSnapshot().state.faceScans)).toEqual(['ordinary'])
    expect(people.getSnapshot().state.assignments.map(({ photoKey }) => photoKey)).toEqual(['ordinary'])
    expect(people.getSnapshot().state.faceProfiles.maya.references.map(({ id }) => id)).toEqual(['reference'])
    expect(people.getSnapshot().state.people).toEqual(initial.people)
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    expect(mocks.save.mock.calls[0][1]).toBe(people.getSnapshot().state)
  })

  it('persists revocation even if removing a linked reference removes the final enrolled profile', async () => {
    const gallery = photo(1)
    const initial = enrolledState()
    initial.faceScans[gallery.key] = faceScan()
    initial.faceProfiles.maya.references = [{ id: 'linked', source: 'manual-photo', embedding: [1, 0], createdAt: '2026-09-13', photoKey: gallery.key }]
    mocks.load.mockResolvedValue(initial)
    const job = create([gallery])
    await settled(job)
    clearGallery('permission')
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    expect(mocks.save.mock.calls[0][1].faceScans).toEqual({})
    expect(mocks.save.mock.calls[0][1].faceProfiles.maya.references).toEqual([])
  })

  it('ignores unrelated and refresh events, while account clearing does not erase persisted enrollment', async () => {
    const item = photo(1)
    const initial = enrolledState()
    initial.faceScans[item.key] = faceScan()
    mocks.load.mockResolvedValue(initial)
    const job = create([item])
    await settled(job)
    clearGallery('permission', 'another:family')
    clearGallery('refresh')
    expect(job.getSnapshot().total).toBe(1)
    clearGallery('account')
    expect(job.getSnapshot().total).toBe(0)
    expect(getPeopleTimelineSession(NAMESPACE).getSnapshot().state).toBe(initial)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('still persists privacy pruning after repeated revocation while another save is pending', async () => {
    const item = photo(1)
    const initial = enrolledState()
    initial.faceScans[item.key] = faceScan()
    mocks.load.mockResolvedValue(initial)
    const job = create([item])
    await settled(job)
    const pending = deferred<boolean>()
    mocks.save.mockReturnValueOnce(pending.promise)
    const people = getPeopleTimelineSession(NAMESPACE)
    const editor = { ...people.getSnapshot().state, people: [{ ...initial.people[0], name: 'Renamed' }] }
    people.replace(editor)
    const editorSave = people.save(editor)
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    clearGallery('permission')
    clearGallery('disconnect')
    pending.resolve(true)
    await editorSave
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
    expect(mocks.save.mock.calls.at(-1)![1].faceScans).toEqual({})
    expect(mocks.save.mock.calls.at(-1)![1].people[0].name).toBe('Renamed')
  })

  it('rejects late scan callbacks after clearing enrollment and rebuilds consumed work on re-enrollment', async () => {
    const pending = deferred<ReturnType<typeof success>>()
    let callback!: (value: FaceScanCheckpoint) => void
    mocks.scan.mockImplementationOnce((_batch, checkpoint) => { callback = checkpoint; return pending.promise })
    const photos = [photo(1), photo(2)]
    const job = create(photos)
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledTimes(1))
    const people = getPeopleTimelineSession(NAMESPACE)
    people.replace({ ...people.getSnapshot().state, faceProfiles: {} })
    pending.resolve(success(photos, callback))
    await settled(job, 'waiting-for-person')
    expect(mocks.save).not.toHaveBeenCalled()
    people.replace({ ...people.getSnapshot().state, faceProfiles: enrolledState().faceProfiles })
    await settled(job)
    expect(mocks.scan).toHaveBeenCalledTimes(2)
    expect(job.getSnapshot().scanned).toBe(2)
  })

  it('rebuilds durable completion after all face data is cleared during an in-flight checkpoint save', async () => {
    const first = photo(1), second = photo(2)
    const initial = enrolledState()
    initial.faceScans[first.key] = faceScan()
    mocks.load.mockResolvedValue(initial)
    const pending = deferred<boolean>()
    mocks.save.mockReturnValueOnce(pending.promise)
    const job = create([first, second])
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    const people = getPeopleTimelineSession(NAMESPACE)
    const cleared = { ...people.getSnapshot().state, faceScans: {}, faceProfiles: {} }
    people.replace(cleared)
    const clearWrite = people.save(cleared)
    expect(job.getSnapshot().scanned).toBe(0)
    pending.resolve(true)
    await clearWrite
    people.replace({ ...people.getSnapshot().state, faceProfiles: enrolledState().faceProfiles })
    await settled(job)
    expect(mocks.scan.mock.calls.map(([batch]) => batch.map((item: PeopleTimelinePhoto) => item.key)))
      .toEqual([[second.key], [first.key, second.key]])
    expect(Object.keys(people.getSnapshot().state.faceScans)).toHaveLength(2)
  })

  it('rolls back failed checkpoint keys without losing newer edits and saves again on explicit retry', async () => {
    const pending = deferred<boolean>()
    mocks.save.mockReturnValueOnce(pending.promise)
    const item = photo(1)
    const job = create([item])
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    expect(job.getSnapshot().scanned).toBe(0)
    const people = getPeopleTimelineSession(NAMESPACE)
    people.replace({ ...people.getSnapshot().state, dateOverrides: { ordinary: { value: '2001', precision: 'year' } } })
    pending.resolve(false)
    await settled(job, 'needs-retry')
    expect(people.getSnapshot().state.faceScans).toEqual({})
    expect(people.getSnapshot().state.dateOverrides.ordinary.value).toBe('2001')
    expect(job.getSnapshot()).toMatchObject({ scanned: 0, pending: 1, error: expect.stringContaining('could not be saved') })
    job.retry()
    await settled(job)
    expect(mocks.save).toHaveBeenCalledTimes(2)
    expect(mocks.scan).toHaveBeenCalledTimes(2)
  })

  it('does not resurrect a failed batch through a queued editor save containing its old optimistic scans', async () => {
    const pending = deferred<boolean>()
    mocks.save.mockReturnValueOnce(pending.promise)
    const job = create([photo(1)])
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    const people = getPeopleTimelineSession(NAMESPACE)
    const editor = { ...people.getSnapshot().state, people: [{ ...people.getSnapshot().state.people[0], name: 'Renamed' }] }
    people.replace(editor)
    const editorWrite = people.save(editor)
    pending.resolve(false)
    await editorWrite
    await settled(job, 'needs-retry')
    const persisted = mocks.save.mock.calls.at(-1)![1] as PeopleTimelineState
    expect(persisted.faceScans).toEqual({})
    expect(persisted.people[0].name).toBe('Renamed')
    expect(persisted).toBe(people.getSnapshot().state)
  })

  it('ignores stale React autosaves after a newer scan batch', async () => {
    const item = photo(1)
    const job = create([item])
    const people = getPeopleTimelineSession(NAMESPACE)
    await people.hydrate()
    const stale = people.getSnapshot().state
    await settled(job)
    const calls = mocks.save.mock.calls.length
    await people.save(stale)
    expect(mocks.save).toHaveBeenCalledTimes(calls)
    expect(people.getSnapshot().state.faceScans[item.key]).toBeDefined()
  })

  it('does not count optimistic checkpoint rows as durable when the gallery changes during persistence', async () => {
    const pending = deferred<boolean>()
    mocks.save.mockReturnValueOnce(pending.promise)
    const first = photo(1), second = photo(2)
    const job = create([first])
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    job.updatePhotos([first, second])
    expect(job.getSnapshot()).toMatchObject({ total: 2, scanned: 0, pending: 2 })
    pending.resolve(false)
    await settled(job, 'needs-retry')
    expect(job.getSnapshot().scanned).toBe(0)
    job.retry()
    await settled(job)
    expect(job.getSnapshot().scanned).toBe(2)
  })

  it('treats a photo removed during a queued checkpoint as cancellation, not a storage error', async () => {
    const pending = deferred<boolean>()
    mocks.save.mockReturnValueOnce(pending.promise)
    const first = photo(1), second = photo(2)
    const job = create([])
    const people = getPeopleTimelineSession(NAMESPACE)
    await people.hydrate()
    const editor = { ...people.getSnapshot().state, dateOverrides: { ordinary: { value: '2001', precision: 'year' as const } } }
    people.replace(editor)
    const editorSave = people.save(editor)
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    job.updatePhotos([first, second])
    await waitFor(() => expect(mocks.scan).toHaveBeenCalledTimes(1))
    expect(Object.keys(people.getSnapshot().state.faceScans)).toHaveLength(2)
    job.updatePhotos([second])
    pending.resolve(true)
    await editorSave
    await settled(job)
    expect(job.getSnapshot()).toMatchObject({ total: 1, scanned: 1, error: undefined })
    expect(Object.keys(people.getSnapshot().state.faceScans)).toEqual([second.key])
  })

  it('processes a 4,697-photo gallery to the end, persisting bounded checkpoints rather than each photo', async () => {
    const photos = Array.from({ length: 4697 }, (_, index) => photo(index + 1))
    const job = create(photos)
    await waitFor(() => expect(job.getSnapshot().status).toBe('complete'), { timeout: 20_000 })
    expect(job.getSnapshot()).toMatchObject({ total: 4697, scanned: 4697, pending: 0, failed: 0 })
    expect(mocks.scan).toHaveBeenCalledTimes(Math.ceil(4697 / 8))
    expect(mocks.save).toHaveBeenCalledTimes(Math.ceil(4697 / 8))
    expect(mocks.scan.mock.calls.every(([batch]) => batch.length <= 8)).toBe(true)
  }, 25_000)

  it('reports index capacity explicitly without claiming remaining photos were scanned', async () => {
    const initial = enrolledState()
    initial.faceScans = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`existing:${index}`, faceScan()]))
    mocks.load.mockResolvedValue(initial)
    const job = create([photo(1)])
    await settled(job, 'needs-retry')
    expect(job.getSnapshot()).toMatchObject({ total: 1, scanned: 0, pending: 1, error: expect.stringContaining('20,000') })
    expect(mocks.scan).not.toHaveBeenCalled()
  })
})
