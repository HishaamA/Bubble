import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMemberSessionCaches } from '../../../app/memberSessionCache'
import { createAndroidGalleryScanSession } from './androidGalleryScanSession'
import { getPeopleTimelineSession } from './peopleTimelineSession'
import { emptyPeopleTimelineState } from './peopleTimelineStore'
import { FACE_SCAN_REVISION } from './types'
import type { PeopleTimelinePhoto, PeopleTimelineState, StoredPhotoFaceScan } from './types'
import type { NativeGalleryScanState } from './nativeGalleryScan'

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), getState: vi.fn(), start: vi.fn(), ack: vi.fn(),
  pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), cancel: vi.fn(),
  permission: vi.fn(), request: vi.fn(),
  appListeners: new Set<(state: { isActive: boolean }) => void>(),
  authorized: new Set<string>(),
}))
vi.mock('@capacitor/app', () => ({ App: {
  getState: vi.fn(async () => ({ isActive: true })),
  addListener: vi.fn(async (_name, listener) => {
    mocks.appListeners.add(listener)
    return { remove: async () => { mocks.appListeners.delete(listener) } }
  }),
} }))
vi.mock('../gallery/phoneGallery', () => ({
  PHONE_GALLERY_CLEARED_EVENT: 'bubble:phone-gallery-cleared',
  isGalleryPhotoAuthorized: (source: string) => mocks.authorized.has(source),
  authorizedGalleryNativeId: (source: string, scope: string) =>
    mocks.authorized.has(source) && source.includes(`scope=${scope}`) ? source.split(':')[1].split('?')[0] : null,
}))
vi.mock('./nativeGalleryScan', async (original) => ({
  ...await original<typeof import('./nativeGalleryScan')>(),
  BackgroundGalleryScan: {
    getState: mocks.getState, start: mocks.start, ack: mocks.ack,
    pause: mocks.pause, resume: mocks.resume, retry: mocks.retry, cancel: mocks.cancel,
    getNotificationPermission: mocks.permission, requestNotificationPermission: mocks.request,
  },
}))
vi.mock('./peopleTimelineStore', async (original) => ({
  ...await original<typeof import('./peopleTimelineStore')>(),
  loadPeopleTimelineState: mocks.load, savePeopleTimelineState: mocks.save,
}))

const SCOPE = 'member:family'
const jobs: ReturnType<typeof createAndroidGalleryScanSession>[] = []
let native: NativeGalleryScanState
function enrolledState(): PeopleTimelineState {
  return { ...emptyPeopleTimelineState(),
    people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01T00:00:00Z' }],
    faceProfiles: { maya: { references: [{ id: 'ref', source: 'enrollment',
      createdAt: '2026-01-01T00:00:00Z', embedding: [1, 0] }] } },
  }
}
function photo(index: number): PeopleTimelinePhoto {
  const id = `device-gallery:${index}`
  const source = `bubble-gallery:${index}?scope=${SCOPE}`
  mocks.authorized.add(source)
  return { id, key: `journal-photo:${id}`, kind: 'journal-photo', origin: 'device-gallery',
    source, scanSource: source, capturedAt: new Date(Date.UTC(2020, 0, index)).toISOString(),
    caption: '', contributorName: '', capsuleId: '', memoryId: '', canScanFaces: true }
}
function result(item: PeopleTimelinePhoto) {
  return { key: item.key, source: item.scanSource as string,
    scan: { scannedAt: '2026-09-14T00:00:00Z', faces: [] } as StoredPhotoFaceScan }
}
function create(photos: PeopleTimelinePhoto[]) {
  const job = createAndroidGalleryScanSession(SCOPE)
  jobs.push(job)
  job.updatePhotos(photos)
  return job
}
function appActive(isActive: boolean) { mocks.appListeners.forEach((listener) => listener({ isActive })) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { resolve, promise }
}
async function started() { await waitFor(() => expect(mocks.start).toHaveBeenCalled()) }

beforeEach(() => {
  clearMemberSessionCaches()
  vi.clearAllMocks()
  mocks.authorized.clear(); mocks.appListeners.clear()
  native = { status: 'idle', total: 0, completed: 0, failed: 0, results: [], revision: FACE_SCAN_REVISION }
  mocks.load.mockResolvedValue(enrolledState())
  mocks.save.mockResolvedValue(true)
  mocks.getState.mockImplementation(async () => ({ ...native, results: native.results.slice(0, 8) }))
  mocks.start.mockImplementation(async ({ photos }) => {
    native = { ...native, status: native.status === 'paused' ? 'paused' : 'running', total: photos.length, revision: FACE_SCAN_REVISION }
    return { ...native }
  })
  mocks.ack.mockImplementation(async ({ entries }) => {
    native.results = native.results.filter((r) => !entries.some((e: typeof r) => r.key === e.key && r.source === e.source))
  })
  mocks.pause.mockImplementation(async () => { native.status = 'paused' })
  mocks.resume.mockImplementation(async () => { native.status = 'running' })
  mocks.retry.mockImplementation(async () => { native.status = 'running'; native.failed = 0; native.failedKeys = [] })
  mocks.cancel.mockImplementation(async () => { native = { status: 'idle', total: 0, completed: 0, failed: 0, results: [] } })
  mocks.permission.mockResolvedValue({ status: 'granted' })
  mocks.request.mockResolvedValue({ status: 'granted' })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(async () => {
  jobs.splice(0).forEach((job) => job.dispose())
  clearMemberSessionCaches()
  await Promise.resolve()
  vi.restoreAllMocks()
})

describe('Android durable background scanner coordinator', () => {
  it('starts only pending authorized references oldest first without resending saved images', async () => {
    const photos = [photo(1), photo(2), photo(3)]
    const stored = enrolledState()
    stored.faceScans[photos[0].key] = result(photos[0]).scan
    mocks.load.mockResolvedValue(stored)
    const unauthorized = photo(4)
    mocks.authorized.delete(unauthorized.scanSource as string)
    const job = create([...photos].reverse().concat(unauthorized))
    await started()
    expect(mocks.start).toHaveBeenCalledWith({ scope: SCOPE, revision: FACE_SCAN_REVISION,
      photos: photos.slice(1).map((p, i) => ({ key: p.key, nativeId: `${i + 2}`, source: p.scanSource })) })
    expect(job.getSnapshot()).toMatchObject({ total: 3, scanned: 1, backgroundEnabled: true, requiresRestart: false })
    appActive(true)
    await waitFor(() => expect(mocks.getState).toHaveBeenCalledTimes(2))
    expect(mocks.start).toHaveBeenCalledOnce()
  })

  it('does not pause/cancel the service when another app is opened; imports when returning', async () => {
    const photos = [photo(1), photo(2)]
    const job = create(photos)
    await started()
    appActive(false)
    expect(mocks.pause).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(job.getSnapshot().status).toBe('running')
    native.results = photos.map(result)
    native.completed = 2; native.status = 'complete'
    expect(job.getSnapshot().scanned).toBe(0)
    appActive(true)
    await waitFor(() => expect(job.getSnapshot().status).toBe('complete'))
    expect(job.getSnapshot().scanned).toBe(2)
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.ack).toHaveBeenCalledWith({ scope: SCOPE, entries: photos.map((p) => ({ key: p.key, source: p.scanSource })) })
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.ack.mock.invocationCallOrder[0])
  })

  it('imports a pre-existing outbox on cold start before deciding what is still unscanned', async () => {
    const photos = [photo(1), photo(2)]
    native = { ...native, status: 'running', results: [result(photos[0])] }
    const job = create(photos)
    await started()
    expect(job.getSnapshot().scanned).toBe(1)
    expect(mocks.start.mock.lastCall?.[0].photos).toEqual([{ key: photos[1].key, nativeId: '2', source: photos[1].scanSource }])
    expect(mocks.ack.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0])
  })

  it('never acknowledges a checkpoint when persistence fails and can import it on retry', async () => {
    const item = photo(1)
    const job = create([item])
    await started()
    mocks.save.mockResolvedValueOnce(false)
    native.results = [result(item)]
    appActive(true)
    await waitFor(() => expect(job.getSnapshot().status).toBe('needs-retry'))
    expect(mocks.ack).not.toHaveBeenCalled()
    expect(job.getSnapshot().scanned).toBe(0)
    expect(native.results).toHaveLength(1)
    job.retry()
    await waitFor(() => expect(job.getSnapshot().scanned).toBe(1))
    expect(mocks.ack).toHaveBeenCalledOnce()
  })

  it('respects a pause from the notification across app restart and resumes only explicitly', async () => {
    native.status = 'paused'
    const job = create([photo(1)])
    await waitFor(() => expect(job.getSnapshot().pauseReason).toBe('manual'))
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
    job.resume()
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce())
    expect(job.getSnapshot().status).toBe('running')
  })

  it('temporarily pauses for enrollment without making the Add person editor wait', async () => {
    const job = create([photo(1)])
    await started()
    const hold = Symbol('editor')
    job.setHold(hold, true)
    await waitFor(() => expect(mocks.pause).toHaveBeenCalledOnce())
    expect(job.getSnapshot().pauseReason).toBe('editor')
    job.setHold(hold, false)
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce())
    expect(job.getSnapshot().status).toBe('running')
  })

  it('does not turn an existing notification pause into an automatic editor resume', async () => {
    native.status = 'paused'
    const job = create([photo(1)])
    const hold = Symbol('editor')
    job.setHold(hold, true)
    await waitFor(() => expect(job.getSnapshot().pauseReason).toBe('manual'))
    job.setHold(hold, false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mocks.resume).not.toHaveBeenCalled()
  })

  it('keeps failed photos distinct from scanned results and retries only on request', async () => {
    const item = photo(1)
    const job = create([item])
    await started()
    native = { ...native, status: 'complete', failed: 1, failedKeys: [item.key] }
    appActive(true)
    await waitFor(() => expect(job.getSnapshot().status).toBe('needs-retry'))
    expect(job.getSnapshot()).toMatchObject({ failed: 1, scanned: 0, pending: 0 })
    expect(mocks.retry).not.toHaveBeenCalled()
    job.retry()
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledOnce())
  })

  it('asks for notification permission only after Enable background checking is pressed', async () => {
    mocks.permission.mockResolvedValue({ status: 'prompt' })
    const job = create([photo(1)])
    await waitFor(() => expect(job.getSnapshot().backgroundPermissionRequired).toBe(true))
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    job.retry()
    await started()
    expect(mocks.request).toHaveBeenCalledOnce()
    expect(job.getSnapshot().backgroundPermissionRequired).toBe(false)
  })

  it('does not start service with notification permission denied', async () => {
    mocks.permission.mockResolvedValue({ status: 'denied' })
    mocks.request.mockResolvedValue({ status: 'denied' })
    const job = create([photo(1)])
    await waitFor(() => expect(job.getSnapshot().backgroundPermissionRequired).toBe(true))
    job.retry()
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce())
    expect(mocks.start).not.toHaveBeenCalled()
    expect(job.getSnapshot().error).toContain('Android Settings')
  })

  it('retries a native engine error without the previous error blocking its retry command', async () => {
    const job = create([photo(1)])
    await started()
    native.status = 'error'; native.error = 'Engine stopped'
    appActive(true)
    await waitFor(() => expect(job.getSnapshot().status).toBe('needs-retry'))
    job.retry()
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledOnce())
    expect(job.getSnapshot().status).toBe('running')
  })

  it('defers starting if the user leaves during an asynchronous native state read', async () => {
    const response = deferred<NativeGalleryScanState>()
    mocks.getState.mockReturnValueOnce(response.promise)
    const job = create([photo(1)])
    await waitFor(() => expect(mocks.getState).toHaveBeenCalledOnce())
    appActive(false)
    response.resolve(native)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mocks.start).not.toHaveBeenCalled()
    expect(job.getSnapshot().status).toBe('paused')
    appActive(true)
    await started()
  })

  it('rejects an older native model revision instead of accepting its outbox as current', async () => {
    const item = photo(1)
    native = { ...native, revision: 'old-model', total: 1, completed: 1, results: [result(item)] }
    const job = create([item])
    await started()
    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(mocks.ack).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(job.getSnapshot().scanned).toBe(0)
    expect(mocks.start.mock.lastCall?.[0].revision).toBe(FACE_SCAN_REVISION)
  })

  it('reconciles additions that arrive while an older native start request is still pending', async () => {
    const response = deferred<NativeGalleryScanState>()
    mocks.start.mockReturnValueOnce(response.promise)
    const photos = [photo(1), photo(2)]
    const job = create(photos.slice(0, 1))
    await started()
    job.updatePhotos(photos)
    response.resolve({ ...native, status: 'running', total: 1 })
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2))
    expect(mocks.start.mock.lastCall?.[0].photos.map((p: { key: string }) => p.key))
      .toEqual(photos.map((p) => p.key))
  })

  it('does not count optimistic imports before their durable save finishes', async () => {
    const item = photo(1)
    const save = deferred<boolean>()
    const job = create([item])
    await started()
    native.results = [result(item)]
    mocks.save.mockReturnValueOnce(save.promise)
    appActive(true)
    await waitFor(() => expect(mocks.save).toHaveBeenCalled())
    expect(job.getSnapshot().scanned).toBe(0)
    expect(job.getSnapshot().status).not.toBe('complete')
    save.resolve(true)
    await waitFor(() => expect(job.getSnapshot().scanned).toBe(1))
  })

  it('retains and retries a final ACK failure even though the last scan is already durable', async () => {
    const item = photo(1)
    const job = create([item])
    await started()
    native.results = [result(item)]
    mocks.ack.mockRejectedValueOnce(new Error('Native acknowledgement failed'))
    appActive(true)
    await waitFor(() => expect(job.getSnapshot().status).toBe('needs-retry'))
    expect(job.getSnapshot()).toMatchObject({ scanned: 1, total: 1 })
    expect(native.results).toHaveLength(1)
    job.retry()
    await waitFor(() => expect(job.getSnapshot().status).toBe('complete'))
    expect(mocks.ack).toHaveBeenCalledTimes(2)
  })

  it.each(['no-profiles', 'empty-library', 'all-saved'])('cancels stale cold native work with %s', async (mode) => {
    const item = photo(1)
    const previous = photo(2)
    const stored = enrolledState()
    if (mode === 'no-profiles') stored.faceProfiles = {}
    if (mode === 'all-saved') stored.faceScans[item.key] = result(item).scan
    mocks.load.mockResolvedValue(stored)
    native = { ...native, status: 'running', total: 1, results: [result(previous)] }
    create(mode === 'empty-library' ? [] : [item])
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledOnce())
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.ack).not.toHaveBeenCalled()
  })

  it('recovers a failed scoped cancellation before starting new work', async () => {
    const photos = [photo(1), photo(2)]
    const job = create(photos)
    await started()
    mocks.cancel.mockRejectedValueOnce(new Error('Temporary cancellation failure'))
    job.updatePhotos(photos.slice(1))
    await waitFor(() => expect(job.getSnapshot().status).toBe('needs-retry'))
    const startsBeforeRetry = mocks.start.mock.calls.length
    job.retry()
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mocks.start.mock.calls.length).toBeGreaterThan(startsBeforeRetry))
  })

  it('does not acknowledge stale results after a gallery revoke during an import', async () => {
    const item = photo(1)
    const pending = deferred<boolean>()
    const job = create([item])
    await started()
    native.results = [result(item)]
    mocks.save.mockReturnValueOnce(pending.promise)
    appActive(true)
    await waitFor(() => expect(mocks.save).toHaveBeenCalled())
    mocks.authorized.clear()
    window.dispatchEvent(new CustomEvent('bubble:phone-gallery-cleared', {
      detail: { cacheNamespace: SCOPE, reason: 'disconnect' },
    }))
    pending.resolve(true)
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledOnce())
    expect(mocks.ack).not.toHaveBeenCalled()
    expect(job.getSnapshot().total).toBe(0)
    expect(Object.keys(getPeopleTimelineSession(SCOPE).getSnapshot().state.faceScans)).toHaveLength(0)
  })

  it('cancels scoped native work when face data is cleared', async () => {
    const job = create([photo(1)])
    await started()
    const people = getPeopleTimelineSession(SCOPE)
    people.replace({ ...people.getSnapshot().state, faceProfiles: {}, faceScans: {} })
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith({ scope: SCOPE }))
    expect(job.getSnapshot().status).toBe('waiting-for-person')
  })

  it('ignores late native results after the account session is disposed', async () => {
    const item = photo(1)
    const response = deferred<NativeGalleryScanState>()
    const job = create([item])
    await started()
    mocks.getState.mockReturnValueOnce(response.promise)
    appActive(true)
    await waitFor(() => expect(mocks.getState).toHaveBeenCalledTimes(2))
    job.dispose()
    response.resolve({ ...native, results: [result(item)] })
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledOnce())
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.ack).not.toHaveBeenCalled()
  })
})
