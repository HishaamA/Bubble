import { App as CapacitorApp } from '@capacitor/app'
import {
  authorizedGalleryNativeId, isGalleryPhotoAuthorized, PHONE_GALLERY_CLEARED_EVENT,
} from '../gallery/phoneGallery'
import type { PhoneGalleryClearedDetail } from '../gallery/phoneGallery'
import { prunePhoneGalleryMatches } from '../phoneGalleryPhotos'
import { getPeopleTimelineSession } from './peopleTimelineSession'
import { BackgroundGalleryScan, isNativeFaceScan } from './nativeGalleryScan'
import type { NativeGalleryScanState } from './nativeGalleryScan'
import type { GalleryScanSnapshot } from './galleryScanSession'
import { FACE_SCAN_REVISION } from './types'
import type { PeopleTimelinePhoto, StoredPhotoFaceScan } from './types'

const POLL_MS = 1500
const BATCH_SIZE = 8
const MAX_STORED_SCANS = 20_000

/**
 * Android owns inference and its durable queue. This foreground coordinator only
 * reconciles consent and imports checkpoints; leaving the route/app does not
 * own or cancel the service. Account departure is still a strict boundary.
 */
export function createAndroidGalleryScanSession(namespace: string) {
  const people = getPeopleTimelineSession(namespace)
  const listeners = new Set<() => void>()
  const holds = new Set<symbol>()
  let active = true
  let epoch = 0
  let nativeActive = false
  let nativeStateReady = false
  let libraryReady = false
  let photos = new Map<string, PeopleTimelinePhoto>()
  let ordered: PeopleTimelinePhoto[] = []
  let enrolled = false
  let manualPaused = false
  let heldPause = false
  let dirty = true
  let libraryVersion = 0
  let starting = false
  let nativeStatus: NativeGalleryScanState['status'] = 'idle'
  let failed = new Set<string>()
  let error: string | undefined
  let fatal = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let worker: Promise<void> | undefined
  let rerun = false
  let command: 'resume' | 'retry' | undefined
  let notificationGranted = false
  let notificationRequested = false
  let backgroundPermissionRequired = false
  let cancelQueue: Promise<unknown> = Promise.resolve()
  let cancellationFailed = false
  const pendingImports = new Set<string>()
  let snapshot: GalleryScanSnapshot = {
    status: 'idle', total: 0, scanned: 0, failed: 0, pending: 0,
    pauseReason: null, requiresRestart: false, backgroundSupported: true,
  }

  const foreground = () => nativeStateReady && nativeActive && document.visibilityState !== 'hidden'
  const valid = (photo: PeopleTimelinePhoto, token: number) => active && epoch === token
    && photos.get(photo.key)?.scanSource === photo.scanSource && isGalleryPhotoAuthorized(photo.scanSource)
  const completedKeys = () => people.getSnapshot().state.faceScans
  const publish = () => {
    const scans = completedKeys()
    const scanned = ordered.reduce((n, photo) => n + Number(Object.hasOwn(scans, photo.key) && !pendingImports.has(photo.key)), 0)
    const failedCount = [...failed].filter((key) => photos.has(key) && !Object.hasOwn(scans, key)).length
    const pending = Math.max(0, photos.size - scanned - failedCount)
    const pauseReason = manualPaused ? 'manual' : holds.size ? 'editor' : null
    const status: GalleryScanSnapshot['status'] = !active || !photos.size ? 'idle'
      : !enrolled ? 'waiting-for-person'
        : fatal ? 'needs-retry'
          : scanned === photos.size ? 'complete'
            : backgroundPermissionRequired ? 'paused'
            : pauseReason ? 'paused'
              : pending === 0 && failedCount ? 'needs-retry'
                : nativeStatus === 'running' || starting ? 'running'
                  : !foreground() ? 'paused' : 'running'
    const next: GalleryScanSnapshot = {
      status, total: photos.size, scanned, failed: failedCount, pending,
      pauseReason: status === 'paused' ? pauseReason ?? 'background' : null,
      error, requiresRestart: false, backgroundSupported: true,
      backgroundEnabled: nativeStatus === 'running',
      backgroundPermissionRequired,
    }
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return
    snapshot = next
    listeners.forEach((notify) => notify())
  }
  const stopTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  const cancel = () => {
    // Ordered behind earlier revocations, and scoped natively so a departed
    // account's delayed cancellation cannot cancel a newly signed-in member.
    cancelQueue = cancelQueue.catch(() => undefined).then(() => BackgroundGalleryScan.cancel({ scope: namespace }))
      .then((value) => { cancellationFailed = false; return value }, (failure) => { cancellationFailed = true; throw failure })
    void cancelQueue.catch(() => undefined)
    nativeStatus = 'idle'
  }
  const fail = (failure: unknown) => {
    fatal = true
    error = failure instanceof Error ? failure.message : 'Background checking paused. Your saved progress is safe. Tap Retry to continue.'
    // A failed JS import must not acknowledge lost checkpoints or keep filling
    // storage. The native outbox remains available for an explicit retry.
    void BackgroundGalleryScan.pause({ scope: namespace }).catch(() => undefined)
  }

  async function importResults(state: NativeGalleryScanState, token: number) {
    const scans: Record<string, StoredPhotoFaceScan> = {}
    const accepted: { key: string; source: string }[] = []
    const captured = new Map<string, PeopleTimelinePhoto>()
    for (const result of state.results) {
      const photo = photos.get(result.key)
      if (!photo || result.source !== photo.scanSource || !valid(photo, token)) continue
      if (!isNativeFaceScan(result.scan)) throw new Error('One background result could not be read safely. Saved progress is intact; retry checking.')
      accepted.push({ key: result.key, source: result.source })
      captured.set(result.key, photo)
      scans[result.key] = result.scan
    }
    if (!accepted.length) return false
    const canWrite = () => active && token === epoch && [...captured.values()].every((photo) => valid(photo, token))
    if (!canWrite()) return false
    for (const key of Object.keys(scans)) if (!Object.hasOwn(completedKeys(), key)) pendingImports.add(key)
    let merged
    try { merged = await people.mergeScans(scans, canWrite) }
    finally { Object.keys(scans).forEach((key) => pendingImports.delete(key)); publish() }
    if (!canWrite()) return false
    if (!merged.saved) throw new Error('Checking paused because progress could not be saved. Free some device storage, then retry.')
    // Native results survive process death until IndexedDB has committed them.
    await BackgroundGalleryScan.ack({ scope: namespace, entries: accepted })
    return true
  }

  function receive(state: NativeGalleryScanState) {
    nativeStatus = state.status
    failed = new Set((state.failedKeys ?? []).filter((key) => photos.has(key)))
    if (state.status === 'paused' && !heldPause && !command) manualPaused = true
    if (state.status === 'error' && command !== 'retry') {
      fatal = true
      error = state.error || 'Background checking paused. Your progress is saved; retry to continue.'
    }
  }

  async function pump() {
    if (!active || !foreground() || !libraryReady || !people.getSnapshot().ready) return
    const token = epoch
    await cancelQueue
    if (!active || token !== epoch) return
    let state = await BackgroundGalleryScan.getState({ scope: namespace, limit: BATCH_SIZE })
    if (!active || token !== epoch) return
    if ((state.total > 0 || state.results.length > 0) && state.revision !== FACE_SCAN_REVISION) {
      // A pipeline upgrade must not label an older native descriptor as a
      // current scan just because its photo reference is unchanged.
      await BackgroundGalleryScan.cancel({ scope: namespace })
      if (!active || token !== epoch) return
      state = { status: 'idle', total: 0, completed: 0, failed: 0, results: [] }
      dirty = true
    }
    if (!enrolled || photos.size === 0) {
      // These are authoritative snapshots (hydration/index readiness is gated
      // above). A previous process must not keep scanning without this consent.
      if (state.total > 0 || state.results.length > 0 || state.status === 'running') {
        await BackgroundGalleryScan.cancel({ scope: namespace })
        if (!active || token !== epoch) return
      }
      nativeStatus = 'idle'
      publish()
      return
    }
    // Catch up after hours outside Bubble without one enormous bridge payload.
    for (let batch = 0; batch < 16 && state.results.length; batch++) {
      if (!enrolled || !await importResults(state, token)) break
      if (!active || token !== epoch || !foreground()) return
      state = await BackgroundGalleryScan.getState({ scope: namespace, limit: BATCH_SIZE })
      if (!active || token !== epoch) return
    }
    receive(state)
    if (state.results.length) rerun = true
    if (!enrolled || photos.size === 0) { publish(); return }
    if (ordered.every(({ key }) => Object.hasOwn(completedKeys(), key))) {
      if (state.total > 0 || state.results.length > 0 || state.status === 'running') {
        await BackgroundGalleryScan.cancel({ scope: namespace })
        if (!active || token !== epoch) return
      }
      nativeStatus = 'idle'; dirty = false; command = undefined
      publish()
      return
    }
    if (holds.size || manualPaused) {
      if (state.status === 'running') {
        if (holds.size && !manualPaused) heldPause = true
        await BackgroundGalleryScan.pause({ scope: namespace })
      }
      nativeStatus = 'paused'
      publish()
      return
    }
    if (fatal) { publish(); return }
    if (!foreground()) { publish(); return }
    if (!notificationGranted) {
      const permission = notificationRequested
        ? await BackgroundGalleryScan.requestNotificationPermission()
        : await BackgroundGalleryScan.getNotificationPermission()
      notificationRequested = false
      if (!active || token !== epoch) return
      notificationGranted = permission.status === 'granted'
      backgroundPermissionRequired = !notificationGranted
      if (!notificationGranted) {
        if (state.status === 'running') {
          await BackgroundGalleryScan.pause({ scope: namespace })
          nativeStatus = 'paused'
        }
        command = undefined
        error = permission.status === 'denied'
          ? 'Allow Bubble notifications in Android Settings so background progress and Pause remain visible.'
          : undefined
        publish()
        return
      }
      error = undefined
    }
    if (!foreground()) { publish(); return }
    if (dirty) {
      const submittedVersion = libraryVersion
      const stored = completedKeys()
      const pending = ordered.filter(({ key }) => !Object.hasOwn(stored, key))
      const capacity = MAX_STORED_SCANS - Object.keys(stored).length
      if (pending.length > capacity) {
        throw new Error('This device’s face index supports 20,000 photos. Choose a smaller gallery selection to continue.')
      }
      const nativePhotos = pending.flatMap((photo) => {
        const nativeId = authorizedGalleryNativeId(photo.scanSource, namespace)
        return nativeId ? [{ key: photo.key, nativeId, source: photo.scanSource as string }] : []
      })
      if (nativePhotos.length) {
        starting = true
        publish()
        state = await BackgroundGalleryScan.start({ scope: namespace, photos: nativePhotos, revision: FACE_SCAN_REVISION })
        starting = false
        if (!active || token !== epoch) return
        receive(state)
      } else if (state.total > 0 || state.results.length > 0 || state.status === 'running') {
        await BackgroundGalleryScan.cancel({ scope: namespace })
        if (!active || token !== epoch) return
        nativeStatus = 'idle'
      }
      if (libraryVersion === submittedVersion) dirty = false
    }
    const nextCommand = command
    if (nextCommand && active && token === epoch && foreground()) {
      if (nextCommand === 'retry') await BackgroundGalleryScan.retry({ scope: namespace })
      else await BackgroundGalleryScan.resume({ scope: namespace })
      if (!active || token !== epoch) return
      if (command === nextCommand) command = undefined
      manualPaused = false
      heldPause = false
      nativeStatus = 'running'
    }
    publish()
  }

  function kick() {
    if (!active) return
    if (worker) { rerun = true; return }
    stopTimer()
    if (!foreground() || !libraryReady || !people.getSnapshot().ready) { publish(); return }
    const runEpoch = epoch
    worker = pump().catch((failure: unknown) => {
      if (!active || epoch !== runEpoch) return
      // Android may lose focus after our visibility check but before its
      // asynchronous permission/start check. Defer, don't turn leaving the app
      // into a broken scanner or consume the user's pending resume action.
      if (typeof failure === 'object' && failure !== null && 'code' in failure
        && failure.code === 'APP_NOT_VISIBLE' && !foreground()) return
      fail(failure)
    }).finally(() => {
      worker = undefined
      starting = false
      publish()
      if (!active || !foreground()) return
      const delay = rerun ? 0 : POLL_MS
      rerun = false
      if (enrolled && photos.size && (!fatal || command)
        && (snapshot.scanned < snapshot.total || dirty) && !backgroundPermissionRequired) timer = setTimeout(kick, delay)
    })
  }
  const invalidate = () => { epoch += 1; dirty = true; cancel(); stopTimer() }
  const reconcilePeople = () => {
    const current = people.getSnapshot()
    const nextEnrolled = current.ready && current.state.people.some(({ id }) =>
      (current.state.faceProfiles[id]?.references.length ?? 0) > 0)
    if (enrolled && !nextEnrolled) {
      invalidate()
      failed.clear()
      fatal = false
      error = undefined
    }
    enrolled = nextEnrolled
    publish()
    kick()
  }
  const removePeopleListener = people.subscribe(reconcilePeople)
  const onClear = (event: Event) => {
    const detail = (event as CustomEvent<PhoneGalleryClearedDetail>).detail
    if (detail?.cacheNamespace !== namespace || detail.reason === 'refresh') return
    invalidate()
    photos.clear(); ordered = []; failed.clear()
    fatal = false; error = undefined; manualPaused = false
    if (detail.reason === 'disconnect' || detail.reason === 'permission') {
      const token = epoch
      const prune = () => {
        if (!active || token !== epoch) return
        const current = people.getSnapshot().state
        const next = prunePhoneGalleryMatches(current, new Set())
        if (next !== current && people.replace(next)) void people.save(next, () => active)
      }
      if (people.getSnapshot().ready) prune()
      else void Promise.resolve(people.hydrate()).then(prune)
    }
    publish()
  }
  const lifecycle = () => {
    // Do not pause Android's service on document/app backgrounding.
    if (!foreground()) stopTimer()
    else notificationGranted = false
    publish()
    kick()
  }
  document.addEventListener('visibilitychange', lifecycle)
  window.addEventListener(PHONE_GALLERY_CLEARED_EVENT, onClear)
  let removeNativeListener: (() => Promise<void>) | undefined
  void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    if (!active) return
    nativeStateReady = true; nativeActive = isActive; lifecycle()
  }).then((handle) => {
    if (active) removeNativeListener = () => handle.remove()
    else void handle.remove()
  }).catch(() => undefined)
  void CapacitorApp.getState().then(({ isActive }) => {
    if (!active || nativeStateReady) return
    nativeStateReady = true; nativeActive = isActive; lifecycle()
  }).catch(() => { if (active) { nativeStateReady = true; nativeActive = true; lifecycle() } })
  void Promise.resolve(people.hydrate()).then(() => { if (active) reconcilePeople() })

  return {
    getSnapshot: () => snapshot,
    subscribe: (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify) } },
    updatePhotos(next: readonly PeopleTimelinePhoto[]) {
      if (!active) return
      libraryReady = true
      const eligible = next.filter((photo) => photo.origin === 'device-gallery' && photo.canScanFaces
        && authorizedGalleryNativeId(photo.scanSource, namespace) !== null)
      const replacement = new Map(eligible.map((photo) => [photo.key, photo]))
      const revoked = [...photos].some(([key, photo]) => replacement.get(key)?.scanSource !== photo.scanSource)
      const changed = replacement.size !== photos.size || [...replacement].some(([key, photo]) =>
        photos.get(key)?.scanSource !== photo.scanSource || photos.get(key)?.capturedAt !== photo.capturedAt)
      if (revoked) invalidate()
      photos = replacement
      ordered = [...photos.values()].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || a.key.localeCompare(b.key))
      if (changed) { dirty = true; libraryVersion += 1 }
      publish(); kick()
    },
    setHold(token: symbol, held: boolean) {
      if (!active) return
      if (held) holds.add(token)
      else {
        holds.delete(token)
        if (!holds.size && heldPause && !manualPaused) command = 'resume'
      }
      publish(); kick()
    },
    pause() { if (active) { manualPaused = true; command = undefined; publish(); kick() } },
    resume() { if (active) { manualPaused = false; command = 'resume'; publish(); kick() } },
    retry() {
      if (!active) return
      fatal = false; error = undefined; manualPaused = false; failed.clear(); command = 'retry'
      if (backgroundPermissionRequired) notificationRequested = true
      if (cancellationFailed) cancel()
      publish(); kick()
    },
    dispose() {
      if (!active) return
      active = false
      invalidate()
      photos.clear(); ordered = []; failed.clear(); holds.clear()
      removePeopleListener()
      document.removeEventListener('visibilitychange', lifecycle)
      window.removeEventListener(PHONE_GALLERY_CLEARED_EVENT, onClear)
      if (removeNativeListener) void removeNativeListener().catch(() => undefined)
      publish(); listeners.clear()
    },
  }
}
