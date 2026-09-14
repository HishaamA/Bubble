import { App as CapacitorApp } from '@capacitor/app'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createMemberSessionCache } from '../../../app/memberSessionCache'
import { isGalleryPhotoAuthorized, PHONE_GALLERY_CLEARED_EVENT } from '../gallery/phoneGallery'
import type { PhoneGalleryClearedDetail } from '../gallery/phoneGallery'
import { prunePhoneGalleryMatches } from '../phoneGalleryPhotos'
import { scanTimelineFaces } from './faceRecognition'
import type { FaceScanCheckpoint } from './faceRecognition'
import { getPeopleTimelineSession } from './peopleTimelineSession'
import type { PeopleTimelinePhoto, StoredPhotoFaceScan } from './types'
import { isBackgroundGalleryScanSupported } from './nativeGalleryScan'
import { createAndroidGalleryScanSession } from './androidGalleryScanSession'

const BATCH_SIZE = 8
const MAX_ATTEMPTS = 3 // First attempt plus at most two transient retries per explicit run.
const MAX_STORED_SCANS = 20_000 // Matches the current persisted timeline schema.

export type GalleryScanSnapshot = {
  status: 'idle' | 'waiting-for-person' | 'running' | 'paused' | 'complete' | 'needs-retry'
  total: number
  scanned: number
  failed: number
  pending: number
  pauseReason: 'manual' | 'background' | 'editor' | null
  error?: string
  requiresRestart: boolean
  backgroundSupported?: boolean
  backgroundEnabled?: boolean
  backgroundPermissionRequired?: boolean
}

/** Prefer Android's durable foreground service; keep the foreground fallback elsewhere. */
export function createGalleryScanSession(namespace: string) {
  if (isBackgroundGalleryScanSupported()) return createAndroidGalleryScanSession(namespace)
  return createForegroundGalleryScanSession(namespace)
}

/** One foreground-only job per warm account, independent of React tab mounts. */
function createForegroundGalleryScanSession(namespace: string) {
  const people = getPeopleTimelineSession(namespace)
  let active = true
  let epoch = 0
  let manualPaused = false
  let nativeActive = true
  let nativeStateReady = false
  let enrolled = false
  let fatal = false
  let error: string | undefined
  let requiresRestart = false
  let worker: Promise<void> | undefined
  let kickQueued = false
  let merging = false
  let controller: AbortController | undefined
  let batchPhotos = new Map<string, PeopleTimelinePhoto>()
  const buffer = new Map<string, StoredPhotoFaceScan>()
  let photos = new Map<string, PeopleTimelinePhoto>()
  let orderedKeys: string[] = []
  let queue: string[] = []
  let head = 0
  const completed = new Set<string>()
  const attempts = new Map<string, number>()
  const failed = new Set<string>()
  const holds = new Set<symbol>()
  const listeners = new Set<() => void>()
  let lastFaceScans = people.getSnapshot().state.faceScans
  let storedScanCount = Object.keys(lastFaceScans).length
  let snapshot: GalleryScanSnapshot = {
    status: 'idle', total: 0, scanned: 0, failed: 0, pending: 0,
    pauseReason: null, requiresRestart: false,
  }

  const background = () => !nativeStateReady || !nativeActive
    || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
  const runnable = () => active && enrolled && !manualPaused && !background() && holds.size === 0 && !fatal
  const rebuildQueue = () => {
    queue = orderedKeys.filter((key) => !completed.has(key) && !failed.has(key))
    head = 0
  }
  const publish = () => {
    const total = photos.size
    const pending = Math.max(0, total - completed.size - failed.size)
    const pauseReason = manualPaused ? 'manual' : background() ? 'background' : holds.size ? 'editor' : null
    const status: GalleryScanSnapshot['status'] = !active || total === 0 ? 'idle'
      : fatal ? 'needs-retry'
        : pending === 0 ? failed.size ? 'needs-retry' : 'complete'
          : !enrolled ? 'waiting-for-person'
            : pauseReason ? 'paused' : 'running'
    const next: GalleryScanSnapshot = { status, total, scanned: completed.size, failed: failed.size, pending,
      pauseReason: status === 'paused' ? pauseReason : null, error, requiresRestart }
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return
    snapshot = next
    listeners.forEach((notify) => notify())
  }
  const abort = () => { controller?.abort() }
  const authorized = (photo: PeopleTimelinePhoto) => isGalleryPhotoAuthorized(photo.scanSource)
  const validPhoto = (photo: PeopleTimelinePhoto, token: number) => active && token === epoch
    && photos.get(photo.key)?.scanSource === photo.scanSource && authorized(photo)

  const failRuntime = (failure: unknown) => {
    fatal = true
    requiresRestart = typeof failure === 'object' && failure !== null
      && 'requiresRestart' in failure && failure.requiresRestart === true
    error = failure instanceof Error && failure.message ? failure.message
      : 'Face matching stopped. Your saved progress is safe; retry when the app is ready.'
  }

  async function flush(token: number) {
    if (!active || token !== epoch || buffer.size === 0) { buffer.clear(); return }
    const scans = Object.fromEntries([...buffer].filter(([key]) => {
      const photo = batchPhotos.get(key)
      return photo !== undefined && validPhoto(photo, token)
    }))
    buffer.clear()
    if (Object.keys(scans).length === 0) return
    const canWrite = () => active && token === epoch && Object.keys(scans).every((key) => {
      const photo = batchPhotos.get(key)
      return photo !== undefined && validPhoto(photo, token)
    })
    merging = true
    try {
      const result = await people.mergeScans(scans, canWrite)
      if (!active || token !== epoch) return
      if (!result.saved) {
        // A library refresh may remove a photo while this checkpoint waits
        // behind another write. That is cancellation, not a storage failure.
        if (!canWrite()) { rebuildQueue(); return }
        failRuntime(new Error('Face matching paused because its progress could not be saved. Free some device storage, then retry.'))
        return
      }
      for (const key of Object.keys(scans)) {
        if (photos.has(key) && Object.hasOwn(people.getSnapshot().state.faceScans, key)) {
          completed.add(key)
          failed.delete(key)
          attempts.delete(key)
        }
      }
    } finally {
      merging = false
      lastFaceScans = people.getSnapshot().state.faceScans
      storedScanCount = Object.keys(lastFaceScans).length
      for (const key of completed) if (!photos.has(key) || !Object.hasOwn(lastFaceScans, key)) completed.delete(key)
      publish()
    }
  }

  async function run() {
    while (runnable() && head < queue.length) {
      if (storedScanCount >= MAX_STORED_SCANS) {
        failRuntime(new Error('This device’s current face index supports 20,000 scanned photos. Remaining photos have not been scanned; choose a smaller gallery selection.'))
        break
      }
      const batch: PeopleTimelinePhoto[] = []
      const size = Math.min(BATCH_SIZE, MAX_STORED_SCANS - storedScanCount)
      while (head < queue.length && batch.length < size) {
        const key = queue[head++]
        const photo = photos.get(key)
        if (!photo || completed.has(key) || failed.has(key)) continue
        if (!authorized(photo)) {
          photos.delete(key)
          attempts.delete(key)
          continue
        }
        batch.push(photo)
      }
      if (batch.length === 0) break
      const token = epoch
      const currentController = new AbortController()
      controller = currentController
      batchPhotos = new Map(batch.map((photo) => [photo.key, photo]))
      const attempted = new Set<string>()
      const checkpoint = (value: FaceScanCheckpoint) => {
        const photo = batchPhotos.get(value.photoKey)
        if (!photo || currentController.signal.aborted || !validPhoto(photo, token)) return
        if (!runnable()) { currentController.abort(); return }
        attempted.add(value.photoKey)
        if (!value.failed && value.faceScan) buffer.set(value.photoKey, value.faceScan)
        else {
          const count = (attempts.get(value.photoKey) ?? 0) + 1
          attempts.set(value.photoKey, count)
          if (count >= MAX_ATTEMPTS) failed.add(value.photoKey)
          else queue.push(value.photoKey)
        }
        publish()
      }
      try {
        const result = await scanTimelineFaces(batch, checkpoint, currentController.signal)
        if (token === epoch && !currentController.signal.aborted) {
          // Also tolerate a scanner implementation returning final results
          // without an incremental callback; incomplete rows count as failures.
          for (const photo of batch) if (!attempted.has(photo.key)) checkpoint({
            photoKey: photo.key, faceScan: result.faceScans[photo.key],
            failed: !result.faceScans[photo.key], completed: 0, total: batch.length,
          })
        }
      } catch (failure) {
        if (active && token === epoch && !currentController.signal.aborted) failRuntime(failure)
      } finally {
        await flush(token)
        if (controller === currentController) controller = undefined
        if (token === epoch) {
          const unfinished = batch.filter((photo) => photos.has(photo.key)
            && !attempted.has(photo.key) && !completed.has(photo.key) && !failed.has(photo.key))
          if (unfinished.length) queue.splice(head, 0, ...unfinished.map(({ key }) => key))
        }
        batchPhotos.clear()
      }
      if (head > 4096 && head > queue.length / 2) { queue = queue.slice(head); head = 0 }
      publish()
      // Bound main-thread work and allow UI, permission and lifecycle events.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  function kick() {
    if (kickQueued || worker || !runnable() || head >= queue.length) { publish(); return }
    kickQueued = true
    queueMicrotask(() => {
      kickQueued = false
      if (!runnable() || worker || head >= queue.length) { publish(); return }
      worker = run().catch(failRuntime).finally(() => {
        worker = undefined
        publish()
        kick()
      })
      publish()
    })
  }

  const reconcilePeople = () => {
    const current = people.getSnapshot()
    const wasEnrolled = enrolled
    enrolled = current.ready && current.state.people.some(({ id }) =>
      (current.state.faceProfiles[id]?.references.length ?? 0) > 0)
    if (wasEnrolled && !enrolled) {
      // Clearing enrollment is a synchronous privacy boundary, even before
      // React propagates its editor/clearing hold to this persistent job.
      epoch += 1
      abort()
      buffer.clear()
      batchPhotos.clear()
      // Clear may arrive while a checkpoint write is awaiting IndexedDB.
      // Refresh bookkeeping even during merging, before its finally observes
      // the new faceScans reference and would otherwise hide this transition.
      lastFaceScans = current.state.faceScans
      storedScanCount = Object.keys(lastFaceScans).length
      completed.clear()
      attempts.clear()
      failed.clear()
      for (const key of orderedKeys) if (photos.has(key) && Object.hasOwn(lastFaceScans, key)) completed.add(key)
      rebuildQueue()
    }
    if (current.state.faceScans !== lastFaceScans && !merging) {
      lastFaceScans = current.state.faceScans
      storedScanCount = Object.keys(lastFaceScans).length
      completed.clear()
      for (const key of orderedKeys) if (photos.has(key) && Object.hasOwn(lastFaceScans, key)) {
        completed.add(key); failed.delete(key); attempts.delete(key)
      }
      rebuildQueue()
    }
    publish()
    kick()
  }
  const removePeopleListener = people.subscribe(reconcilePeople)
  const lifecycle = () => { if (background()) abort(); publish(); kick() }
  const onClear = (event: Event) => {
    const detail = (event as CustomEvent<PhoneGalleryClearedDetail>).detail
    if (detail?.cacheNamespace !== namespace || detail.reason === 'refresh') return
    epoch += 1
    abort()
    buffer.clear()
    batchPhotos.clear()
    photos.clear()
    orderedKeys = []
    queue = []
    head = 0
    completed.clear()
    attempts.clear()
    failed.clear()
    fatal = false
    error = undefined
    requiresRestart = false
    if (detail.reason === 'disconnect' || detail.reason === 'permission') {
      const token = epoch
      const prune = () => {
        if (!active || epoch !== token) return
        const current = people.getSnapshot().state
        const next = prunePhoneGalleryMatches(current, new Set())
        if (next !== current && people.replace(next)) {
          // Privacy pruning must still reach storage after a second revoke
          // event. The captured session rejects account departure and saves
          // its latest state, so later edits cannot restore the removed rows.
          void people.save(next, () => active)
        }
      }
      // The job outlives Journal. Privacy cleanup cannot depend on a mounted
      // route effect, and a still-pending hydration must be covered as well.
      if (people.getSnapshot().ready) prune()
      else void Promise.resolve(people.hydrate()).then(prune)
    }
    publish()
  }
  document.addEventListener('visibilitychange', lifecycle)
  window.addEventListener(PHONE_GALLERY_CLEARED_EVENT, onClear)
  let removeNativeListener: (() => Promise<void>) | undefined
  void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    if (!active) return
    nativeStateReady = true
    nativeActive = isActive
    lifecycle()
  }).then((handle) => {
    if (active) removeNativeListener = () => handle.remove()
    else void handle.remove()
  }).catch(() => undefined)
  void CapacitorApp.getState().then(({ isActive }) => {
    if (!active || nativeStateReady) return
    nativeStateReady = true
    nativeActive = isActive
    lifecycle()
  }).catch(() => {
    // Web builds have no App plugin; document visibility remains authoritative.
    if (active) { nativeStateReady = true; lifecycle() }
  })
  void Promise.resolve(people.hydrate()).then(() => { if (active) reconcilePeople() })

  return {
    getSnapshot: () => snapshot,
    subscribe: (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify) } },
    updatePhotos(next: readonly PeopleTimelinePhoto[]) {
      if (!active) return
      const eligible = next.filter((photo) => photo.origin === 'device-gallery' && photo.canScanFaces && authorized(photo))
      const replacement = new Map(eligible.map((photo) => [photo.key, photo]))
      const changed = replacement.size !== photos.size || [...replacement].some(([key, photo]) =>
        photos.get(key)?.scanSource !== photo.scanSource || photos.get(key)?.capturedAt !== photo.capturedAt)
      if (!changed) return
      if ([...batchPhotos.values()].some((photo) => replacement.get(photo.key)?.scanSource !== photo.scanSource)) abort()
      photos = replacement
      orderedKeys = [...photos.values()].sort((a, b) =>
        Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || a.key.localeCompare(b.key)).map(({ key }) => key)
      const alreadyDurable = new Set(completed)
      completed.clear()
      const scans = people.getSnapshot().state.faceScans
      for (const key of orderedKeys) if (Object.hasOwn(scans, key)
        && (!merging || !batchPhotos.has(key) || alreadyDurable.has(key))) completed.add(key)
      for (const key of attempts.keys()) if (!photos.has(key)) attempts.delete(key)
      for (const key of failed) if (!photos.has(key) || completed.has(key)) failed.delete(key)
      rebuildQueue()
      publish()
      kick()
    },
    setHold(token: symbol, held: boolean) {
      if (!active) return
      if (held) { holds.add(token); abort() } else holds.delete(token)
      publish(); kick()
    },
    pause() { if (active) { manualPaused = true; abort(); publish() } },
    resume() { if (active) { manualPaused = false; publish(); kick() } },
    retry() {
      if (!active || requiresRestart) return
      fatal = false; error = undefined; failed.clear(); attempts.clear()
      rebuildQueue(); publish(); kick()
    },
    dispose() {
      active = false
      epoch += 1
      abort(); buffer.clear(); batchPhotos.clear(); photos.clear()
      queue = []; orderedKeys = []; completed.clear(); failed.clear(); attempts.clear(); holds.clear()
      removePeopleListener()
      document.removeEventListener('visibilitychange', lifecycle)
      window.removeEventListener(PHONE_GALLERY_CLEARED_EVENT, onClear)
      if (removeNativeListener) void removeNativeListener().catch(() => undefined)
      publish(); listeners.clear()
    },
  }
}

const sessions = createMemberSessionCache<ReturnType<typeof createGalleryScanSession>>({ dispose: (session) => session.dispose() })
export function getGalleryScanSession(namespace: string) {
  let session = sessions.get(namespace)
  if (!session) { session = createGalleryScanSession(namespace); sessions.set(namespace, session) }
  return session
}

export function useGalleryScanSession(namespace: string, photos?: readonly PeopleTimelinePhoto[], hold = false) {
  const session = useMemo(() => getGalleryScanSession(namespace), [namespace])
  const [holdToken] = useState(() => Symbol('gallery-editor'))
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  useEffect(() => { session.setHold(holdToken, hold); return () => session.setHold(holdToken, false) }, [hold, holdToken, session])
  useEffect(() => { if (photos !== undefined) session.updatePhotos(photos) }, [photos, session])
  return { ...snapshot, pause: session.pause, resume: session.resume, retry: session.retry }
}
