import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createMemberSessionCache } from '../../../app/memberSessionCache'
import { subscribeToAppResume } from '../../../lib/appResume'
import { getPeopleTimelineSession } from '../people/peopleTimelineSession'
import { prunePhoneGalleryMatches } from '../phoneGalleryPhotos'
import {
  clearGalleryAuthorization, isPhoneGallerySupported, PhoneGallery,
  PHONE_GALLERY_CLEARED_EVENT, setGalleryAuthorization,
} from './phoneGallery'
import type { PhoneGalleryAsset, PhoneGalleryClearedDetail, PhoneGalleryPermission } from './phoneGallery'
import { loadGalleryMetadata, normalizeGalleryPhoto, saveGalleryMetadata } from './phoneGalleryMetadata'

export type PhoneGalleryState = {
  supported: boolean
  enabled: boolean
  /** The one-time choice is separate from permission and can be changed in Settings. */
  setupComplete: boolean
  setupPersisted: boolean
  permission: PhoneGalleryPermission
  photos: PhoneGalleryAsset[]
  /** True only after verifying the saved index or completing a consistent enumeration. */
  ready: boolean
  progress: { loaded: number } | null
  error: string | null
}

const CHOICE_STORAGE_ERROR = 'Your choice applies for now, but this device could not remember it. Check available device storage.'
const INDEX_STORAGE_ERROR = 'Your photos are available now, but the index could not be saved. It will need a fresh check next time.'
type RunMode = 'connect' | 'refresh' | 'check'

export function createPhoneGallerySession(cacheNamespace: string) {
  let index = loadGalleryMetadata(cacheNamespace)
  const people = getPeopleTimelineSession(cacheNamespace)
  const supported = isPhoneGallerySupported()
  let state: PhoneGalleryState = {
    supported, enabled: supported && index.enabled,
    setupComplete: index.setupComplete, setupPersisted: index.setupPersisted,
    permission: supported ? 'prompt' : 'unavailable', photos: [],
    ready: !supported || !index.enabled, progress: null, error: null,
  }
  let active = true
  let generation = 0
  let pending: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<PhoneGalleryState>) => {
    state = { ...state, ...patch }
    listeners.forEach((notify) => notify())
  }
  const current = (token: number) => active && token === generation && state.enabled
  const allowed = (permission: PhoneGalleryPermission): permission is 'granted' | 'limited' => permission === 'granted' || permission === 'limited'

  const rememberChoice = (enabled: boolean) => {
    const saved = saveGalleryMetadata(cacheNamespace, enabled, enabled ? index.photos : [], {
      setupComplete: true, ...(enabled ? { revision: index.revision, permission: index.permission } : {}),
    })
    publish({ setupComplete: true, setupPersisted: saved.setupPersisted,
      error: saved.setupPersisted ? null : CHOICE_STORAGE_ERROR })
    return saved
  }
  const pruneMatches = () => {
    const prune = () => {
      if (!active) return
      const next = prunePhoneGalleryMatches(people.getSnapshot().state, new Set())
      // Captured session rejects account departure. Its ordered save queue
      // persists the latest state, including repeated permission changes.
      if (people.replace(next)) void people.save(next, () => active)
    }
    if (people.getSnapshot().ready) prune()
    else void Promise.resolve(people.hydrate()).then(prune)
  }
  const forget = (reason: 'disconnect' | 'permission', notify = true) => {
    generation += 1
    pending = undefined
    const saved = rememberChoice(false)
    index = { enabled: false, setupComplete: true, setupPersisted: saved.setupPersisted, photos: [] }
    publish({ enabled: false, photos: [], ready: true, progress: null,
      permission: reason === 'permission' ? 'denied' : state.permission })
    pruneMatches()
    if (notify) clearGalleryAuthorization(cacheNamespace, reason)
  }
  const onCleared = (event: Event) => {
    const detail = (event as CustomEvent<PhoneGalleryClearedDetail>).detail
    if (active && detail?.cacheNamespace === cacheNamespace && detail.reason === 'permission' && state.enabled) {
      forget('permission', false)
    }
  }
  if (typeof window !== 'undefined') window.addEventListener(PHONE_GALLERY_CLEARED_EVENT, onCleared)

  const run = (mode: RunMode): Promise<void> => {
    if (!active || !supported || !state.enabled) return Promise.resolve()
    if (pending) return pending
    const token = ++generation
    const quiet = mode === 'check'
    publish({ progress: quiet ? null : { loaded: 0 }, error: null })
    const work = (async () => {
      try {
        const result = await (mode === 'connect' ? PhoneGallery.requestPermission() : PhoneGallery.getPermission())
        if (!current(token)) return
        const permission = result.status
        if (!allowed(permission)) {
          forget('permission')
          publish({ permission, error: !state.setupPersisted ? CHOICE_STORAGE_ERROR : permission === 'unavailable'
            ? 'Phone gallery access is not available here.'
            : 'Allow photo access in Settings to connect your phone gallery.' })
          return
        }
        if (permission === 'limited' && index.permission !== 'limited') {
          setGalleryAuthorization(cacheNamespace, [])
          publish({ permission, photos: [], ready: false })
        } else publish({ permission })
        const revision = (await PhoneGallery.getLibraryRevision()).revision
        if (!current(token)) return
        if (typeof revision !== 'string' || !revision || revision.length > 512) throw new Error('Invalid library revision.')
        if (mode === 'check' && index.revision === revision && index.permission === permission) {
          // Disk cache is only authorized after a fresh, scope-sensitive native
          // fingerprint. A verified empty library can also be reused.
          if (state.photos !== index.photos) setGalleryAuthorization(cacheNamespace, index.photos)
          publish({ photos: index.photos, ready: true, progress: null,
            error: state.setupPersisted ? null : CHOICE_STORAGE_ERROR })
          return
        }
        if (permission === 'limited' && (index.permission !== permission || index.revision !== revision)) {
          setGalleryAuthorization(cacheNamespace, [])
          publish({ photos: [], ready: false })
        }
        // Full-access refreshes preserve live rows and face-scan progress until
        // a complete, internally consistent replacement is ready.
        const discovered = new Map<string, PhoneGalleryAsset>()
        let offset = 0
        for (let pageNumber = 0; ; pageNumber += 1) {
          if (pageNumber >= 10000) throw new Error('The photo library is too large to index in one session.')
          const page = await PhoneGallery.listPhotos({ offset, limit: 100 })
          if (!current(token)) return
          if (!Array.isArray(page.photos) || typeof page.hasMore !== 'boolean') throw new Error('The phone returned an invalid photo index.')
          for (const raw of page.photos) {
            const photo = normalizeGalleryPhoto(raw, cacheNamespace)
            if (photo) discovered.set(photo.id, photo)
          }
          if (!quiet) publish({ progress: { loaded: discovered.size } })
          if (!page.hasMore) break
          offset += 100 // Native slots, including missing/revoked iOS rows.
        }
        const finalPermission = (await PhoneGallery.getPermission()).status
        if (!current(token)) return
        if (!allowed(finalPermission)) { forget('permission'); return }
        const finalRevision = (await PhoneGallery.getLibraryRevision()).revision
        if (!current(token)) return
        if (finalPermission !== permission || finalRevision !== revision) {
          throw new Error('The phone library changed during indexing. Try refreshing again.')
        }
        const photos = [...discovered.values()].sort((left, right) =>
          right.capturedAt.localeCompare(left.capturedAt) || left.id.localeCompare(right.id))
        setGalleryAuthorization(cacheNamespace, photos)
        const saved = saveGalleryMetadata(cacheNamespace, true, photos, {
          setupComplete: true, revision, permission: finalPermission,
        })
        index = { enabled: true, setupComplete: true, setupPersisted: saved.setupPersisted,
          photos, revision, permission: finalPermission }
        publish({ permission: finalPermission, photos, ready: true, progress: null,
          setupComplete: true, setupPersisted: saved.setupPersisted,
          error: !saved.setupPersisted ? CHOICE_STORAGE_ERROR : !saved.indexPersisted ? INDEX_STORAGE_ERROR : null })
      } catch {
        if (!current(token)) return
        try {
          const permission = (await PhoneGallery.getPermission()).status
          if (!current(token)) return
          if (!allowed(permission)) {
            forget('permission')
            publish({ permission, error: state.setupPersisted
              ? 'Photo access changed. Reconnect your phone gallery in Settings.' : CHOICE_STORAGE_ERROR })
            return
          }
          if (permission === 'limited') {
            setGalleryAuthorization(cacheNamespace, [])
            publish({ permission, photos: [], ready: false })
          }
        } catch { /* Never publish an unverified disk cache when permission checks fail. */ }
        if (current(token)) publish({ progress: null, error: !state.setupPersisted ? CHOICE_STORAGE_ERROR
          : state.ready ? 'Could not refresh the phone gallery. Your previous photo index is unchanged.'
            : 'Could not verify the phone gallery. Refresh to check your current photo selection.' })
      } finally {
        if (token === generation) pending = undefined
      }
    })()
    pending = work
    void work.then(() => { if (pending === work) pending = undefined })
    return work
  }

  // One persistent subscription per account, not one per mounted panel.
  const removeResume = supported ? subscribeToAppResume(() => { void run('check') }) : () => undefined
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    hydrate() { return state.enabled && !state.ready ? run('check') : Promise.resolve() },
    /** Invoke only from the explicit Connect gallery consent button. */
    connect() {
      if (!active) return Promise.resolve()
      if (!supported) {
        publish({ error: 'Phone gallery access requires the installed Android or iOS app. You can still upload chosen photos.' })
        return Promise.resolve()
      }
      if (pending) return pending
      rememberChoice(true)
      publish({ enabled: true })
      return run('connect')
    },
    skipSetup() { if (active) forget('disconnect') },
    refresh: () => run('refresh'),
    disconnect() { if (active) forget('disconnect') },
    async openSettings() {
      if (!active || !supported) return
      try {
        const result = await PhoneGallery.openSettings()
        if (active && !result.opened) publish({ error: 'Open this app’s photo permissions in your phone settings.' })
      } catch {
        if (active) publish({ error: 'Open this app’s photo permissions in your phone settings.' })
      }
    },
    dispose() {
      active = false
      generation += 1
      pending = undefined
      publish({ photos: [], ready: false, progress: null })
      clearGalleryAuthorization(cacheNamespace, 'account')
      removeResume()
      if (typeof window !== 'undefined') window.removeEventListener(PHONE_GALLERY_CLEARED_EVENT, onCleared)
      listeners.clear()
    },
  }
}

const sessions = createMemberSessionCache<ReturnType<typeof createPhoneGallerySession>>({ dispose: (session) => session.dispose() })
function getSession(cacheNamespace: string) {
  let session = sessions.get(cacheNamespace)
  if (!session) { session = createPhoneGallerySession(cacheNamespace); sessions.set(cacheNamespace, session) }
  return session
}
export function usePhoneGallery(cacheNamespace: string) {
  const session = useMemo(() => getSession(cacheNamespace), [cacheNamespace])
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  useEffect(() => { void session.hydrate() }, [session])
  return { ...state, connect: session.connect, refresh: session.refresh, skipSetup: session.skipSetup,
    disconnect: session.disconnect, openSettings: session.openSettings }
}
