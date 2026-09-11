import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { createMemberSessionCache } from '../../app/memberSessionCache'
import { CAPSULES_CHANGED_EVENT } from '../capsules/capsuleChanges'
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

/** Matches synced capsules by ID, with week start as the legacy weekly identity. */
function sameCapsule(left: FamilyCapsule, right: FamilyCapsule) {
  return left.id === right.id || (
    left.kind === 'weekly' &&
    right.kind === 'weekly' &&
    Boolean(left.weekStart) &&
    left.weekStart === right.weekStart
  )
}

/** Preserves durable local media while accepting authoritative family metadata. */
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

/** Flattens revealed Capsule photos into chronologically sortable journal rows. */
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

const archiveWarmLifetimeMs = 30_000

type ArchiveSnapshot = { capsules: FamilyCapsule[]; clock: Date; loading: boolean }
type ArchiveSession = {
  store: CapsuleStore
  snapshot: ArchiveSnapshot
  refreshedAt: number
  disposed: boolean
  dirty: boolean
  epoch: number
  pending: Promise<FamilyCapsule[]> | null
  listeners: Set<() => void>
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => ArchiveSnapshot
}

function createArchiveSession(store: CapsuleStore): ArchiveSession {
  const session: ArchiveSession = {
    store,
    snapshot: { capsules: [], clock: new Date(), loading: true },
    refreshedAt: 0,
    disposed: false,
    dirty: false,
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

function disposeArchiveSession(session: ArchiveSession) {
  session.disposed = true
  session.epoch += 1
  session.pending = null
  session.snapshot = { capsules: [], clock: new Date(), loading: true }
  session.listeners.forEach((listener) => listener())
  session.listeners.clear()
}

/** Isolated test/store sessions can be reused during React's effect replay. */
function resumeIsolatedArchiveSession(session: ArchiveSession) {
  session.disposed = false
}

const archiveSessions = createMemberSessionCache<ArchiveSession>({ dispose: disposeArchiveSession })
let listeningForCapsuleChanges = false

/** Keep warm offline data fresh even when its Journal consumer is unmounted. */
function listenForCapsuleChanges() {
  if (listeningForCapsuleChanges) return
  listeningForCapsuleChanges = true
  window.addEventListener(CAPSULES_CHANGED_EVENT, (event) => {
    const namespace = (event as CustomEvent<{ cacheNamespace?: string }>).detail?.cacheNamespace
    if (typeof namespace !== 'string') return
    const session = archiveSessions.get(namespace)
    if (!session || session.disposed) return
    session.dirty = true
    if (session.listeners.size > 0) void refreshArchive(session)
  })
}

function publishArchive(session: ArchiveSession, capsules: FamilyCapsule[]) {
  if (session.disposed) return
  session.snapshot = { capsules, clock: new Date(), loading: false }
  session.listeners.forEach((listener) => listener())
}

/** Compares metadata/source identity without re-reading or serializing Blob bytes. */
function unchangedCapsule(previous: FamilyCapsule | undefined, next: FamilyCapsule) {
  if (!previous || previous.photos.length !== next.photos.length) return false
  const metadataKeys = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const key of metadataKeys) {
    if (key !== 'photos' && previous[key as keyof FamilyCapsule] !== next[key as keyof FamilyCapsule]) return false
  }
  return next.photos.every((photo, index) => {
    const oldPhoto = previous.photos[index]
    const keys = new Set([...Object.keys(oldPhoto), ...Object.keys(photo)])
    return [...keys].every((key) => oldPhoto[key as keyof CapsulePhoto] === photo[key as keyof CapsulePhoto])
  })
}

/** One read worker survives tab remounts; local content publishes before network/persistence. */
function refreshArchive(session: ArchiveSession, allowWarm = false): Promise<FamilyCapsule[]> {
  if (session.disposed) return Promise.resolve([])
  if (session.pending) return session.pending
  const now = Date.now()
  const revealPassed = session.snapshot.capsules.some(({ opensAt }) => {
    const revealTime = new Date(opensAt).getTime()
    return revealTime > session.snapshot.clock.getTime() && revealTime <= now
  })
  if (allowWarm && !session.dirty && !revealPassed && !session.snapshot.loading && now - session.refreshedAt < archiveWarmLifetimeMs) {
    return Promise.resolve(session.snapshot.capsules)
  }
  const epoch = session.epoch
  session.dirty = false
  const isCurrent = () => !session.disposed && session.epoch === epoch
  const request = (async () => {
    let localCapsules = session.snapshot.capsules
    try {
      const stored = await session.store.list()
      if (!isCurrent()) return []
      localCapsules = stored
      publishArchive(session, stored)
    } catch {
      // Family sync can still populate the archive if device storage is unavailable.
    }
    if (!isCurrent()) return []
    try {
      const family = await fetchFamilyCapsules()
      if (!isCurrent()) return []
      const merged = mergeJournalCapsules(localCapsules, family)
      publishArchive(session, merged)
      const localById = new Map(localCapsules.map((capsule) => [capsule.id, capsule]))
      for (const capsule of merged) {
        if (!isCurrent()) return []
        if (!unchangedCapsule(localById.get(capsule.id), capsule)) {
          await session.store.save(capsule).catch(() => undefined)
        }
      }
    } catch {
      if (isCurrent()) publishArchive(session, localCapsules)
    }
    if (!isCurrent()) return []
    session.refreshedAt = Date.now()
    return session.snapshot.capsules
  })()
  session.pending = request
  void request.finally(() => {
    if (session.pending === request) session.pending = null
    // A local edit arriving during this read must not be lost behind its result.
    if (!session.disposed && session.dirty && session.listeners.size > 0) void refreshArchive(session)
  })
  return request
}

type JournalCapsuleArchiveOptions = {
  cacheNamespace: string
  enabled?: boolean
  store?: CapsuleStore
}

/** Hydrates local and family Capsules, exposing only photos whose reveal passed. */
export function useJournalCapsuleArchive({
  cacheNamespace,
  enabled = true,
  store: suppliedStore,
}: JournalCapsuleArchiveOptions) {
  const session = useMemo(
    () => {
      if (suppliedStore) return createArchiveSession(suppliedStore)
      const cached = archiveSessions.get(cacheNamespace)
      if (cached && !cached.disposed) return cached
      const next = createArchiveSession(typeof window === 'undefined'
        ? createMemoryCapsuleStore()
        : createDefaultCapsuleStore(cacheNamespace))
      archiveSessions.set(cacheNamespace, next)
      return next
    },
    [cacheNamespace, suppliedStore],
  )
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const { capsules, clock } = snapshot

  /** Reconciles both sources and advances the reveal clock used by the journal. */
  const refresh = useCallback(() => refreshArchive(session), [session])

  useEffect(() => {
    if (!enabled) return
    listenForCapsuleChanges()
    if (suppliedStore) resumeIsolatedArchiveSession(session)
    let active = true
    let unsubscribe: () => void = () => undefined
    // Realtime callbacks may outlive this hook by one task; the active flag
    // prevents those late responses from writing into an unmounted consumer.
    const refreshWhileActive = () => { if (active) void refreshArchive(session) }

    void refreshArchive(session, true)
    void subscribeToFamilyCapsules(() => void refreshWhileActive())
      .then((stop) => {
        if (active) unsubscribe = stop
        else stop()
      })
      .catch(() => undefined)

    /** Reconciles immediately when browser connectivity returns. */
    const refreshWhenOnline = () => void refreshWhileActive()
    /** Avoids network work until a background document becomes visible. */
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshWhileActive()
    }
    window.addEventListener('online', refreshWhenOnline)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const signedUrlRefresh = window.setInterval(refreshWhileActive, 50 * 60 * 1000)

    return () => {
      active = false
      unsubscribe()
      window.clearInterval(signedUrlRefresh)
      window.removeEventListener('online', refreshWhenOnline)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      if (suppliedStore) disposeArchiveSession(session)
    }
  }, [enabled, session, suppliedStore])

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
    loading: enabled && snapshot.loading,
    refresh,
  }
}
