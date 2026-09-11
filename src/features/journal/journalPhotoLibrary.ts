import { App as CapacitorApp } from '@capacitor/app'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createMemberSessionCache } from '../../app/memberSessionCache'
import { getCapsulePhotoCapturedAt } from '../capsules/capsulePhotoDate'
import { processCapsuleImage } from '../capsules/processCapsuleImage'
import type { ProcessedCapsulePhoto } from '../capsules/types'
import {
  fetchFamilyJournalPhotos,
  subscribeToFamilyJournalPhotos,
  uploadFamilyJournalPhoto,
} from './journalPhotoService'
import {
  createDefaultJournalPhotoStore,
} from './journalPhotoStore'
import {
  JOURNAL_LIBRARY_ID,
  type JournalPhoto,
  type JournalPhotoImportProgress,
  type JournalPhotoImportResult,
  type JournalPhotoStore,
} from './journalPhotoTypes'
import type { UnlockedCapsulePhoto } from './capsuleJournalArchive'

/** Produces an RFC 4122 version-4 identifier even in older WebViews. */
function createPhotoId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Turns a filename into bounded, human-readable initial caption text. */
function captionFromFilename(filename: string) {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

/** Provides deterministic newest-first ordering when timestamps tie. */
function newestFirst(left: JournalPhoto, right: JournalPhoto) {
  return right.capturedAt.localeCompare(left.capturedAt) ||
    right.id.localeCompare(left.id)
}

/** Keeps process-independent Blob data in preference to a short-lived URL. */
function preferDurableImageSource(
  current: JournalPhoto['image'],
  stored: JournalPhoto['image'],
) {
  if (current instanceof Blob) return current
  if (stored instanceof Blob) return stored
  return current
}

/** Merges a store refresh without replacing durable Blobs with expiring URLs. */
export function mergeLocalJournalPhotos(
  currentPhotos: readonly JournalPhoto[],
  storedPhotos: readonly JournalPhoto[],
) {
  const currentById = new Map(currentPhotos.map((photo) => [photo.id, photo]))
  const mergedStored = storedPhotos.map((storedPhoto) => {
    const currentPhoto = currentById.get(storedPhoto.id)
    if (!currentPhoto) return storedPhoto
    return {
      ...storedPhoto,
      ...currentPhoto,
      image: preferDurableImageSource(currentPhoto.image, storedPhoto.image),
      thumbnail: preferDurableImageSource(
        currentPhoto.thumbnail,
        storedPhoto.thumbnail,
      ),
      syncStatus: currentPhoto.syncStatus === 'synced'
        ? 'synced' as const
        : storedPhoto.syncStatus,
    }
  })
  const storedIds = new Set(mergedStored.map(({ id }) => id))
  return [
    ...mergedStored,
    ...currentPhotos.filter(({ id }) => !storedIds.has(id)),
  ].sort(newestFirst)
}

/** Replaces one photo by ID and restores canonical timeline ordering. */
function upsertJournalPhoto(
  photos: readonly JournalPhoto[],
  photo: JournalPhoto,
) {
  return [
    ...photos.filter(({ id }) => id !== photo.id),
    photo,
  ].sort(newestFirst)
}

/** Reconciles authoritative family rows with unsynced local imports. */
export function mergeJournalPhotos(
  localPhotos: readonly JournalPhoto[],
  familyPhotos: readonly JournalPhoto[],
) {
  const localById = new Map(localPhotos.map((photo) => [photo.id, photo]))
  const mergedFamily = familyPhotos.map((familyPhoto) => {
    const localPhoto = localById.get(familyPhoto.id)
    if (!localPhoto) return familyPhoto
    return {
      ...familyPhoto,
      image: typeof localPhoto.image === 'string'
        ? familyPhoto.image
        : localPhoto.image,
      thumbnail: typeof localPhoto.thumbnail === 'string'
        ? familyPhoto.thumbnail
        : localPhoto.thumbnail,
      syncStatus: 'synced' as const,
    }
  })
  const familyIds = new Set(mergedFamily.map(({ id }) => id))
  return [
    ...mergedFamily,
    ...localPhotos.filter(({ id }) => !familyIds.has(id)),
  ].sort(newestFirst)
}

/** Adapts a library photo to the shared unlocked-photo viewer contract. */
export function journalPhotoAsUnlocked(
  photo: JournalPhoto,
): UnlockedCapsulePhoto {
  return {
    ...photo,
    capsuleId: JOURNAL_LIBRARY_ID,
    capsuleTitle: 'Family photos',
    capsuleOpensAt: '1970-01-01T00:00:00.000Z',
  }
}

type JournalPhotoLibraryOptions = {
  cacheNamespace: string
  contributorName?: string
  enabled?: boolean
  store?: JournalPhotoStore
}

const idleImportProgress: JournalPhotoImportProgress = {
  importing: false,
  completed: 0,
  total: 0,
}

const libraryWarmLifetimeMs = 30_000
type LibrarySnapshot = { photos: JournalPhoto[]; hydrated: boolean }
type LibrarySession = {
  store: JournalPhotoStore
  snapshot: LibrarySnapshot
  refreshedAt: number
  disposed: boolean
  epoch: number
  pending: Promise<JournalPhoto[]> | null
  listeners: Set<() => void>
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => LibrarySnapshot
}

function createLibrarySession(store: JournalPhotoStore): LibrarySession {
  const session: LibrarySession = {
    store,
    snapshot: { photos: [], hydrated: false },
    refreshedAt: 0,
    disposed: false,
    epoch: 0,
    pending: null,
    listeners: new Set(),
    subscribe: (listener) => {
      session.listeners.add(listener)
      return () => { session.listeners.delete(listener) }
    },
    getSnapshot: () => session.snapshot,
  }
  return session
}

function disposeLibrarySession(session: LibrarySession) {
  session.disposed = true
  session.epoch += 1
  session.pending = null
  session.snapshot = { photos: [], hydrated: false }
  session.listeners.forEach((listener) => listener())
  session.listeners.clear()
}

/** Isolated test/store sessions can be reused during React's effect replay. */
function resumeIsolatedLibrarySession(session: LibrarySession) {
  session.disposed = false
}

const librarySessions = createMemberSessionCache<LibrarySession>({ dispose: disposeLibrarySession })

function publishLibrary(session: LibrarySession, photos: JournalPhoto[], hydrated = session.snapshot.hydrated) {
  if (session.disposed) return
  session.snapshot = { photos, hydrated }
  session.listeners.forEach((listener) => listener())
}

/** A single scoped reader survives tab remounts without restarting storage/network work. */
function refreshLibrarySession(session: LibrarySession, cacheNamespace: string, allowWarm = false): Promise<JournalPhoto[]> {
  if (session.disposed) return Promise.resolve([])
  if (session.pending) return session.pending
  if (allowWarm && session.snapshot.hydrated && Date.now() - session.refreshedAt < libraryWarmLifetimeMs) {
    return Promise.resolve(session.snapshot.photos)
  }
  const epoch = session.epoch
  const isCurrent = () => !session.disposed && session.epoch === epoch
  const request = (async () => {
    let storedPhotos: JournalPhoto[] = []
    try {
      storedPhotos = await session.store.list()
      if (!isCurrent()) return []
      publishLibrary(session, mergeLocalJournalPhotos(session.snapshot.photos, storedPhotos), true)
    } catch {
      // Network hydration can still work when device storage is unavailable.
    }
    if (!isCurrent()) return []
    try {
      const familyPhotos = await fetchFamilyJournalPhotos(cacheNamespace)
      if (!isCurrent()) return []
      if (familyPhotos !== null) {
        publishLibrary(session, mergeJournalPhotos(session.snapshot.photos, familyPhotos), true)
        // Never persist expiring remote-only URLs. Retain durable imported Blobs.
        for (const photo of storedPhotos) {
          if (!isCurrent()) return []
          if (photo.syncStatus === 'synced' &&
            typeof photo.image === 'string' && /^https?:\/\//i.test(photo.image) &&
            typeof photo.thumbnail === 'string' && /^https?:\/\//i.test(photo.thumbnail)) {
            await session.store.remove(photo.id).catch(() => undefined)
          }
        }
      }
    } catch {
      // Keep the already-published offline library visible.
    }
    if (!isCurrent()) return []
    if (!session.snapshot.hydrated) publishLibrary(session, session.snapshot.photos, true)
    session.refreshedAt = Date.now()
    return session.snapshot.photos
  })()
  session.pending = request
  void request.finally(() => { if (session.pending === request) session.pending = null })
  return request
}

/**
 * Owns account-scoped photo hydration, serialized imports, background upload,
 * realtime refresh, and expiring signed-URL replacement.
 */
export function useJournalPhotoLibrary({
  cacheNamespace,
  contributorName = 'You',
  enabled = true,
  store: suppliedStore,
}: JournalPhotoLibraryOptions) {
  const session = useMemo(
    () => {
      if (suppliedStore) return createLibrarySession(suppliedStore)
      const cached = librarySessions.get(cacheNamespace)
      if (cached && !cached.disposed) return cached
      const next = createLibrarySession(createDefaultJournalPhotoStore(cacheNamespace))
      librarySessions.set(cacheNamespace, next)
      return next
    },
    [cacheNamespace, suppliedStore],
  )
  const store = session.store
  const photosRef = useRef(session.snapshot.photos)
  const subscribe = useCallback((listener: () => void) => session.subscribe(() => {
    photosRef.current = session.snapshot.photos
    listener()
  }), [session])
  const snapshot = useSyncExternalStore(subscribe, session.getSnapshot, session.getSnapshot)
  const { photos } = snapshot
  const loading = enabled && !snapshot.hydrated
  const [importProgress, setImportProgress] = useState(idleImportProgress)
  const generationRef = useRef(0)
  const syncPromiseRef = useRef<{
    generation: number
    promise: Promise<void>
  } | null>(null)
  const syncRequestedRef = useRef(false)
  const syncFailureCountsRef = useRef(new Map<string, number>())
  const importQueueRef = useRef(Promise.resolve())

  // State and ref move together because queued sync work must read the latest
  // photo set before React commits its next render.
  const replacePhotos = useCallback((next: JournalPhoto[]) => {
    photosRef.current = next
    publishLibrary(session, next)
    return next
  }, [session])

  // Coalesce refreshes within an account generation so focus, realtime, and
  // connectivity events cannot fan out duplicate network/storage reads.
  const refresh = useCallback(() => refreshLibrarySession(session, cacheNamespace), [cacheNamespace, session])

  // One serialized worker drains durable pending photos. A request arriving
  // mid-pass sets a flag so the same worker loops once more before it exits.
  const syncPending = useCallback(function requestPendingSync(): Promise<void> {
    const generation = generationRef.current
    syncRequestedRef.current = true
    const existing = syncPromiseRef.current
    if (existing?.generation === generation) return existing.promise

    /** Rejects queued uploads after the account/cache generation changes. */
    const isCurrent = () => generationRef.current === generation
    /** Drains one bounded pending-upload pass and repeats only when requested. */
    const request = (async () => {
      let syncedAny = false
      do {
        syncRequestedRef.current = false
        const pending = photosRef.current
          .filter((photo) =>
            photo.syncStatus === 'pending' &&
            photo.image instanceof Blob &&
            photo.thumbnail instanceof Blob &&
            typeof photo.thumbnailWidth === 'number' &&
            typeof photo.thumbnailHeight === 'number',
          )
          .sort((left, right) =>
            (syncFailureCountsRef.current.get(left.id) ?? 0) -
              (syncFailureCountsRef.current.get(right.id) ?? 0),
          )
        let consecutiveFailures = 0
        for (const photo of pending) {
          if (!isCurrent()) return
          const prepared: ProcessedCapsulePhoto = {
            image: photo.image as Blob,
            thumbnail: photo.thumbnail as Blob,
            width: photo.width,
            height: photo.height,
            thumbnailWidth: photo.thumbnailWidth as number,
            thumbnailHeight: photo.thumbnailHeight as number,
          }
          let syncedId: string | null
          try {
            syncedId = await uploadFamilyJournalPhoto({
              photoId: photo.id,
              photo: prepared,
              caption: photo.caption,
              capturedAt: photo.capturedAt,
              expectedCacheNamespace: cacheNamespace,
            })
          } catch {
            syncFailureCountsRef.current.set(
              photo.id,
              (syncFailureCountsRef.current.get(photo.id) ?? 0) + 1,
            )
            consecutiveFailures += 1
            // Try the next record so one malformed photo cannot permanently
            // starve the queue. Stop after a few consecutive failures because
            // they usually mean the network or backend is unavailable.
            if (consecutiveFailures >= 3) break
            continue
          }
          if (!syncedId || !isCurrent()) break
          consecutiveFailures = 0
          syncFailureCountsRef.current.delete(photo.id)
          syncedAny = true
          const next = photosRef.current.map((candidate) =>
            candidate.id === photo.id
              ? { ...candidate, syncStatus: 'synced' as const }
              : candidate,
          )
          replacePhotos(next)
          await store.save(
            next.find(({ id }) => id === photo.id) ?? photo,
          ).catch(() => undefined)
        }
      } while (syncRequestedRef.current && isCurrent())

      if (syncedAny && isCurrent()) await refresh()
    })()
    syncPromiseRef.current = { generation, promise: request }
    void request.finally(() => {
      if (syncPromiseRef.current?.promise === request) {
        syncPromiseRef.current = null
      }
      if (syncRequestedRef.current && isCurrent()) {
        void requestPendingSync()
      }
    })
    return request
  }, [cacheNamespace, refresh, replacePhotos, store])

  // Imports are serialized to preserve file order and keep peak image-decoding
  // memory bounded on mobile devices.
  const importPhotos = useCallback((
    files: readonly File[],
  ): Promise<JournalPhotoImportResult> => {
    if (files.length === 0) return Promise.resolve({ added: 0, failed: 0 })
    const generation = generationRef.current
    const request = importQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (generationRef.current !== generation) {
          return { added: 0, failed: files.length }
        }
        setImportProgress({ importing: true, completed: 0, total: files.length })
        let added = 0
        let failed = 0

        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]
          if (!file || generationRef.current !== generation) {
            failed += files.length - index
            break
          }
          try {
            const capturedAt = await getCapsulePhotoCapturedAt(file)
            const processed = await processCapsuleImage(file)
            if (generationRef.current !== generation) {
              failed += files.length - index
              break
            }
            const photo: JournalPhoto = {
              id: createPhotoId(),
              image: processed.image,
              thumbnail: processed.thumbnail,
              width: processed.width,
              height: processed.height,
              thumbnailWidth: processed.thumbnailWidth,
              thumbnailHeight: processed.thumbnailHeight,
              caption: captionFromFilename(file.name),
              capturedAt,
              contributorName: contributorName.trim() || 'You',
              ownedByCurrentUser: true,
              syncStatus: 'pending',
            }
            await store.save(photo)
            added += 1
            if (generationRef.current !== generation) {
              failed += files.length - index - 1
              break
            }
            replacePhotos(upsertJournalPhoto(photosRef.current, photo))
          } catch {
            failed += 1
          }
          if (generationRef.current === generation) {
            setImportProgress({
              importing: true,
              completed: index + 1,
              total: files.length,
            })
          }
        }

        if (generationRef.current === generation) {
          setImportProgress({
            importing: false,
            completed: files.length,
            total: files.length,
          })
          void syncPending()
        }
        return { added, failed }
      })
    importQueueRef.current = request.then(() => undefined)
    return request
  }, [contributorName, replacePhotos, store, syncPending])

  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    photosRef.current = session.snapshot.photos
    // oxlint-disable-next-line react/set-state-in-effect -- Reset per-consumer import progress when changing the active account namespace.
    setImportProgress(idleImportProgress)
    syncPromiseRef.current = null
    syncRequestedRef.current = false
    syncFailureCountsRef.current.clear()
    importQueueRef.current = Promise.resolve()
    if (!enabled) {
      return () => {
        if (generationRef.current === generation) generationRef.current += 1
      }
    }
    let active = true
    if (suppliedStore) resumeIsolatedLibrarySession(session)
    void refreshLibrarySession(session, cacheNamespace, true)
      .then(() => {
        if (!active || generationRef.current !== generation) return undefined
        return syncPending()
      })
    return () => {
      active = false
      if (generationRef.current === generation) generationRef.current += 1
      if (suppliedStore) disposeLibrarySession(session)
    }
  }, [cacheNamespace, enabled, session, suppliedStore, syncPending])

  useEffect(() => {
    if (!enabled) return
    const generation = generationRef.current
    let active = true
    let unsubscribe: () => void = () => undefined
    void subscribeToFamilyJournalPhotos(() => {
      if (active && generationRef.current === generation) void refresh()
    }, cacheNamespace)
      .then((stop) => {
        if (active) unsubscribe = stop
        else stop()
      })
      .catch(() => undefined)

    /** Flushes pending uploads before replacing expiring server URLs. */
    const refreshAndSync = () => {
      if (!active || generationRef.current !== generation) return
      void syncPending().then(() => {
        if (active && generationRef.current === generation) void refresh()
      })
    }
    /** Defers foreground work until the document is actually visible. */
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshAndSync()
    }
    window.addEventListener('online', refreshAndSync)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    let removeNativeListener: (() => Promise<void>) | undefined
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (active && generationRef.current === generation && isActive) {
        refreshAndSync()
      }
    })
      .then((handle) => {
        if (active) removeNativeListener = () => handle.remove()
        else void handle.remove()
      })
      .catch(() => undefined)

    const signedUrlRefresh = window.setInterval(
      () => {
        if (active && generationRef.current === generation) void refresh()
      },
      50 * 60 * 1000,
    )
    return () => {
      active = false
      unsubscribe()
      window.clearInterval(signedUrlRefresh)
      window.removeEventListener('online', refreshAndSync)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      void removeNativeListener?.()
    }
  }, [cacheNamespace, enabled, refresh, syncPending])

  return {
    photos,
    loading,
    importProgress,
    importPhotos,
    refresh,
  }
}
