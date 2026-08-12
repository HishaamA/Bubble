import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createDefaultCapsuleStore,
  createMemoryCapsuleStore,
} from '../capsules/capsuleStore'
import {
  fetchFamilyCapsules,
  subscribeToFamilyCapsules,
} from '../capsules/capsuleService'
import type {
  CapsulePhoto,
  CapsuleStore,
  FamilyCapsule,
} from '../capsules/types'

export type UnlockedCapsulePhoto = CapsulePhoto & {
  capsuleTitle: string
  capsuleOpensAt: string
}

function sameCapsule(left: FamilyCapsule, right: FamilyCapsule) {
  return left.id === right.id || (
    left.kind === 'weekly' &&
    right.kind === 'weekly' &&
    Boolean(left.weekStart) &&
    left.weekStart === right.weekStart
  )
}

function mergePhotos(
  localCapsule: FamilyCapsule,
  familyCapsule: FamilyCapsule,
) {
  const localPhotos = new Map(
    localCapsule.photos.map((photo) => [photo.id, photo]),
  )
  const durableFamilyPhotos = familyCapsule.photos.map((familyPhoto) => {
    const localPhoto = localPhotos.get(familyPhoto.id)
    if (!localPhoto) return familyPhoto
    return {
      ...familyPhoto,
      image: typeof localPhoto.image === 'string'
        ? familyPhoto.image
        : localPhoto.image,
      thumbnail: typeof localPhoto.thumbnail === 'string'
        ? familyPhoto.thumbnail
        : localPhoto.thumbnail,
    }
  })
  const familyPhotoIds = new Set(durableFamilyPhotos.map(({ id }) => id))
  const pendingPhotos = localCapsule.photos
    .filter((photo) =>
      photo.syncStatus === 'pending' && !familyPhotoIds.has(photo.id),
    )
    .map((photo) => ({ ...photo, capsuleId: familyCapsule.id }))

  return [...durableFamilyPhotos, ...pendingPhotos].sort((left, right) =>
    left.capturedAt.localeCompare(right.capturedAt),
  )
}

/**
 * Keeps local, metadata-stripped Blob photos available offline while treating
 * the family response as authoritative for Capsule timing and synced media.
 */
export function mergeJournalCapsules(
  localCapsules: FamilyCapsule[],
  familyCapsules: FamilyCapsule[],
) {
  const consumedLocalIds = new Set<string>()
  const mergedFamily = familyCapsules.map((familyCapsule) => {
    const localCapsule = localCapsules.find((candidate) =>
      sameCapsule(candidate, familyCapsule),
    )
    if (!localCapsule) return familyCapsule
    consumedLocalIds.add(localCapsule.id)
    return {
      ...familyCapsule,
      photos: mergePhotos(localCapsule, familyCapsule),
    }
  })

  return [
    ...mergedFamily,
    ...localCapsules.filter((capsule) =>
      !consumedLocalIds.has(capsule.id) &&
      !familyCapsules.some((familyCapsule) =>
        sameCapsule(capsule, familyCapsule),
      ),
    ),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function unlockedCapsulePhotos(
  capsules: FamilyCapsule[],
  now: Date,
): UnlockedCapsulePhoto[] {
  const nowTime = now.getTime()
  if (!Number.isFinite(nowTime)) return []

  return capsules.flatMap((capsule) => {
    const opensAt = new Date(capsule.opensAt).getTime()
    if (!Number.isFinite(opensAt) || opensAt > nowTime) return []
    return capsule.photos
      .filter((photo) => Number.isFinite(new Date(photo.capturedAt).getTime()))
      .map((photo) => ({
        ...photo,
        capsuleTitle: capsule.title,
        capsuleOpensAt: capsule.opensAt,
      }))
  }).sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
}

async function loadArchive(store: CapsuleStore) {
  let localCapsules: FamilyCapsule[] = []
  try {
    localCapsules = await store.list()
  } catch {
    // Family sync can still populate the read-only Journal archive.
  }

  try {
    const merged = mergeJournalCapsules(
      localCapsules,
      await fetchFamilyCapsules(),
    )
    await Promise.all(merged.map((capsule) => store.save(capsule)))
      .catch(() => undefined)
    return merged
  } catch {
    return localCapsules
  }
}

type JournalCapsuleArchiveOptions = {
  cacheNamespace: string
  enabled?: boolean
  store?: CapsuleStore
}

export function useJournalCapsuleArchive({
  cacheNamespace,
  enabled = true,
  store: suppliedStore,
}: JournalCapsuleArchiveOptions) {
  const store = useMemo(
    () => suppliedStore ?? (
      typeof window === 'undefined'
        ? createMemoryCapsuleStore()
        : createDefaultCapsuleStore(cacheNamespace)
    ),
    [cacheNamespace, suppliedStore],
  )
  const [capsules, setCapsules] = useState<FamilyCapsule[]>([])
  const [loading, setLoading] = useState(enabled)
  const [clock, setClock] = useState(() => new Date())

  const refresh = useCallback(async () => {
    const next = await loadArchive(store)
    setCapsules(next)
    setClock(new Date())
    return next
  }, [store])

  useEffect(() => {
    if (!enabled) return

    let active = true
    let unsubscribe: () => void = () => undefined
    const refreshWhileActive = async () => {
      const next = await loadArchive(store)
      if (active) {
        setCapsules(next)
        setClock(new Date())
        setLoading(false)
      }
    }

    void refreshWhileActive()
    void subscribeToFamilyCapsules(() => void refreshWhileActive())
      .then((stop) => {
        if (active) unsubscribe = stop
        else stop()
      })
      .catch(() => undefined)

    const refreshWhenOnline = () => void refreshWhileActive()
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshWhileActive()
    }
    window.addEventListener('online', refreshWhenOnline)
    document.addEventListener('visibilitychange', refreshWhenVisible)

    return () => {
      active = false
      unsubscribe()
      window.removeEventListener('online', refreshWhenOnline)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [enabled, store])

  useEffect(() => {
    if (!enabled || capsules.length === 0) return
    const currentTime = Date.now()
    const nearestUnlock = capsules.reduce<number | null>((nearest, capsule) => {
      const opensAt = new Date(capsule.opensAt).getTime()
      if (!Number.isFinite(opensAt) || opensAt <= currentTime) return nearest
      return nearest === null || opensAt < nearest ? opensAt : nearest
    }, null)
    if (nearestUnlock === null) return

    const maximumDelay = 2_147_483_647
    const delay = Math.min(
      maximumDelay,
      Math.max(50, nearestUnlock - currentTime + 50),
    )
    const timer = window.setTimeout(() => void refresh(), delay)
    return () => window.clearTimeout(timer)
  }, [capsules, enabled, refresh])

  return {
    capsules,
    clock,
    loading,
    refresh,
  }
}
