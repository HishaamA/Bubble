import { App as CapacitorApp } from '@capacitor/app'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
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

function captionFromFilename(filename: string) {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function newestFirst(left: JournalPhoto, right: JournalPhoto) {
  return right.capturedAt.localeCompare(left.capturedAt) ||
    right.id.localeCompare(left.id)
}

function preferDurableImageSource(
  current: JournalPhoto['image'],
  stored: JournalPhoto['image'],
) {
  if (current instanceof Blob) return current
  if (stored instanceof Blob) return stored
  return current
}

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

function upsertJournalPhoto(
  photos: readonly JournalPhoto[],
  photo: JournalPhoto,
) {
  return [
    ...photos.filter(({ id }) => id !== photo.id),
    photo,
  ].sort(newestFirst)
}

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

export function useJournalPhotoLibrary({
  cacheNamespace,
  contributorName = 'You',
  enabled = true,
  store: suppliedStore,
}: JournalPhotoLibraryOptions) {
  const store = useMemo(
    () => suppliedStore ?? createDefaultJournalPhotoStore(cacheNamespace),
    [cacheNamespace, suppliedStore],
  )
  const [photos, setPhotos] = useState<JournalPhoto[]>([])
  const [loading, setLoading] = useState(enabled)
  const [importProgress, setImportProgress] = useState(idleImportProgress)
  const photosRef = useRef(photos)
  const generationRef = useRef(0)
  const refreshPromiseRef = useRef<{
    generation: number
    promise: Promise<JournalPhoto[]>
  } | null>(null)
  const syncPromiseRef = useRef<{
    generation: number
    promise: Promise<void>
  } | null>(null)
  const syncRequestedRef = useRef(false)
  const syncFailureCountsRef = useRef(new Map<string, number>())
  const importQueueRef = useRef(Promise.resolve())

  const replacePhotos = useCallback((next: JournalPhoto[]) => {
    photosRef.current = next
    setPhotos(next)
    return next
  }, [])

  const refresh = useCallback(() => {
    const generation = generationRef.current
    const existing = refreshPromiseRef.current
    if (existing?.generation === generation) return existing.promise

    const isCurrent = () => generationRef.current === generation
    const request = (async () => {
      let storedPhotos: JournalPhoto[] = []
      try {
        storedPhotos = await store.list()
        if (!isCurrent()) return photosRef.current
        replacePhotos(mergeLocalJournalPhotos(
          photosRef.current,
          storedPhotos,
        ))
      } catch {
        // A family-server refresh can still populate this active session.
      }

      try {
        const familyPhotos = await fetchFamilyJournalPhotos(cacheNamespace)
        if (!isCurrent() || familyPhotos === null) return photosRef.current
        const latestLocalPhotos = photosRef.current
        const merged = mergeJournalPhotos(latestLocalPhotos, familyPhotos)
        replacePhotos(merged)

        const staleRemoteCacheIds = storedPhotos
          .filter((photo) =>
            photo.syncStatus === 'synced' &&
            typeof photo.image === 'string' &&
            /^https?:\/\//i.test(photo.image) &&
            typeof photo.thumbnail === 'string' &&
            /^https?:\/\//i.test(photo.thumbnail),
          )
          .map(({ id }) => id)
        // Signed URLs expire, so never persist a newly fetched remote-only
        // record and remove URL-only rows written by older app versions.
        // Locally imported Blob copies remain durable and offline-capable.
        void (async () => {
          for (const photoId of staleRemoteCacheIds) {
            if (!isCurrent()) return
            await store.remove(photoId).catch(() => undefined)
          }
        })()
        return merged
      } catch {
        return photosRef.current
      }
    })()
    refreshPromiseRef.current = { generation, promise: request }
    void request.finally(() => {
      if (refreshPromiseRef.current?.promise === request) {
        refreshPromiseRef.current = null
      }
    })
    return request
  }, [cacheNamespace, replacePhotos, store])

  const syncPending = useCallback(function requestPendingSync(): Promise<void> {
    const generation = generationRef.current
    syncRequestedRef.current = true
    const existing = syncPromiseRef.current
    if (existing?.generation === generation) return existing.promise

    const isCurrent = () => generationRef.current === generation
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
    photosRef.current = []
    setPhotos([])
    setImportProgress(idleImportProgress)
    refreshPromiseRef.current = null
    syncPromiseRef.current = null
    syncRequestedRef.current = false
    syncFailureCountsRef.current.clear()
    importQueueRef.current = Promise.resolve()
    if (!enabled) {
      setLoading(false)
      return () => {
        if (generationRef.current === generation) generationRef.current += 1
      }
    }
    let active = true
    setLoading(true)
    void refresh()
      .then(() => {
        if (!active || generationRef.current !== generation) return undefined
        return syncPending()
      })
      .finally(() => {
        if (active && generationRef.current === generation) setLoading(false)
      })
    return () => {
      active = false
      if (generationRef.current === generation) generationRef.current += 1
    }
  }, [cacheNamespace, enabled, refresh, store, syncPending])

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

    const refreshAndSync = () => {
      if (!active || generationRef.current !== generation) return
      void syncPending().then(() => {
        if (active && generationRef.current === generation) void refresh()
      })
    }
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
