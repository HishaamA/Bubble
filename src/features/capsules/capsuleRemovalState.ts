import type { CapsuleStore, FamilyCapsule } from './types'

export type CapsuleRemovalMarkers = {
  capsules: { capsuleId: string; creatorId?: string; ownedByCurrentUser: boolean; wasPublished?: boolean; weekStart?: string }[]
  photos: { capsuleId: string; photoId: string; uploaderId?: string; ownedByCurrentUser: boolean; wasPublished?: boolean }[]
}
const memory = new Map<string, CapsuleRemovalMarkers>()
const empty = (): CapsuleRemovalMarkers => ({ capsules: [], photos: [] })
const key = (scope: string) => `bubble:capsule-removals:v1:${encodeURIComponent(scope)}`

/** Confirmed deletion receipts outlive caches, preventing stale offline uploads from returning. */
export function readCapsuleRemovals(scope: string): CapsuleRemovalMarkers {
  if (memory.has(scope)) return memory.get(scope)!
  try {
    const parsed = JSON.parse(localStorage.getItem(key(scope)) ?? 'null')
    if (parsed && Array.isArray(parsed.capsules) && Array.isArray(parsed.photos)) {
      const markers: CapsuleRemovalMarkers = {
        capsules: parsed.capsules.filter((entry: CapsuleRemovalMarkers['capsules'][number]) =>
          entry && typeof entry.capsuleId === 'string' && typeof entry.ownedByCurrentUser === 'boolean'),
        photos: parsed.photos.filter((entry: CapsuleRemovalMarkers['photos'][number]) =>
          entry && typeof entry.capsuleId === 'string' && typeof entry.photoId === 'string'
          && typeof entry.ownedByCurrentUser === 'boolean'),
      }
      memory.set(scope, markers)
      return markers
    }
  } catch { /* Device storage may be unavailable; server receipts remain authoritative. */ }
  return empty()
}

export function retainCapsuleRemovals(scope: string, next: CapsuleRemovalMarkers) {
  const current = readCapsuleRemovals(scope)
  const capsuleKey = (item: CapsuleRemovalMarkers['capsules'][number]) => JSON.stringify([item.capsuleId, item.creatorId, item.ownedByCurrentUser])
  const capsules = new Map(current.capsules.map((item) => [capsuleKey(item), item]))
  const photos = new Map(current.photos.map((item) => [JSON.stringify([item.capsuleId, item.photoId, item.uploaderId, item.ownedByCurrentUser]), item]))
  next.capsules.forEach((item) => capsules.set(capsuleKey(item), item))
  next.photos.forEach((item) => photos.set(JSON.stringify([item.capsuleId, item.photoId, item.uploaderId, item.ownedByCurrentUser]), item))
  const merged = { capsules: [...capsules.values()], photos: [...photos.values()] }
  // A successful server deletion must take effect this session even if local
  // storage is full. A future online refresh restores the server's receipt.
  memory.set(scope, merged)
  try { localStorage.setItem(key(scope), JSON.stringify(merged)) } catch { /* Best effort cache. */ }
}

export function applyCapsuleRemovals(capsules: readonly FamilyCapsule[], scope: string): FamilyCapsule[] {
  const removed = readCapsuleRemovals(scope)
  return capsules.filter((capsule) => !removed.capsules.some((marker) =>
    (marker.capsuleId === capsule.id && (
      (marker.creatorId && marker.creatorId === capsule.createdById)
      || (!capsule.createdById && marker.wasPublished === true)
      || (!capsule.createdById && marker.ownedByCurrentUser && (capsule.ownedByCurrentUser || capsule.familySynced === false))
    // Only a published family receipt can suppress the whole shared week.
    // Cancelling an offline draft must not hide another member's server Capsule.
    )) || (marker.wasPublished === true && capsule.kind === 'weekly'
      && marker.weekStart && marker.weekStart === capsule.weekStart),
  )).map((capsule) => {
    const photos = capsule.photos.filter((photo) => !removed.photos.some((marker) =>
      marker.capsuleId === capsule.id && marker.photoId === photo.id && (
        (marker.uploaderId && marker.uploaderId === photo.uploaderId)
        || (!photo.uploaderId && marker.wasPublished === true)
        || (!photo.uploaderId && marker.ownedByCurrentUser && photo.ownedByCurrentUser)
      ),
    ))
    if (photos.length === capsule.photos.length) return capsule
    return { ...capsule, photos, totalPhotoCount: Math.max(photos.length,
      (capsule.totalPhotoCount ?? capsule.photos.length) - (capsule.photos.length - photos.length)) }
  })
}

/** Filtering at the persistence boundary also protects against late pre-delete cache writes. */
export function withCapsuleRemovals(store: CapsuleStore, scope: string): CapsuleStore {
  return {
    list: async () => applyCapsuleRemovals(await store.list(), scope),
    save: async (capsule) => {
      const [visible] = applyCapsuleRemovals([capsule], scope)
      if (visible) await store.save(visible)
      else await store.remove(capsule.id)
    },
    remove: (id) => store.remove(id),
  }
}
