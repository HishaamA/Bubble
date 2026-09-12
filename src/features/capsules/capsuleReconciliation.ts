import { getWeeklyCapsuleWindow, toLocalDateInput } from './capsuleDates'
import type { FamilyCapsule } from './types'
import { sameCapsulePhotoOwner } from './capsulePhotoOwnership'

/** Gives offline weekly drafts a deterministic identity for the same local week. */
function weeklyCapsuleId(weekStart: Date) {
  return `weekly-${toLocalDateInput(weekStart)}`
}

/** Creates the durable offline fallback for the week containing `now`. */
export function createCurrentWeeklyCapsule(
  now: Date,
  createdByName = 'You',
): FamilyCapsule {
  const capsuleWindow = getWeeklyCapsuleWindow(now)
  return {
    id: weeklyCapsuleId(capsuleWindow.weekStart),
    kind: 'weekly',
    title: 'This week',
    weekStart: toLocalDateInput(capsuleWindow.weekStart),
    createdAt: capsuleWindow.weekStart.toISOString(),
    closesAt: capsuleWindow.closesAt.toISOString(),
    opensAt: capsuleWindow.opensAt.toISOString(),
    createdByName,
    photos: [],
    totalPhotoCount: 0,
    familySynced: false,
  }
}

/** Keeps the current weekly Capsule first, then orders each kind newest-first. */
export function orderCapsules(capsules: FamilyCapsule[]): FamilyCapsule[] {
  return [...capsules].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'weekly' ? -1 : 1
    return right.createdAt.localeCompare(left.createdAt)
  })
}

/** Reconciles renewable family rows with durable local bytes and pending uploads. */
export function mergeCapsules(
  localCapsules: FamilyCapsule[],
  familyCapsules: FamilyCapsule[],
): FamilyCapsule[] {
  /*
   * The server owns shared identity, membership-visible counts, and renewable
   * signed URLs; IndexedDB owns Blob bytes that must survive a restart and the
   * queue of photos not uploaded yet. A weekly draft can also acquire a new
   * server UUID, so weekStart is the reconciliation key until that happens.
   *
   * Merging therefore cannot be a simple "remote wins" replacement. Matching
   * local Blobs replace transient remote URLs for the same photo, and unmatched
   * pending/local Blob photos stay attached until a later fetch proves the
   * server has accepted their IDs. This keeps offline work durable without
   * allowing stale local metadata to override the family's authoritative row.
   */
  const consumedLocalIds = new Set<string>()
  const mergedFamily = familyCapsules.map((familyCapsule) => {
    const localCapsule = localCapsules.find((candidate) => (
      candidate.id === familyCapsule.id || (
        candidate.kind === 'weekly' &&
        familyCapsule.kind === 'weekly' &&
        candidate.weekStart === familyCapsule.weekStart
      )
    ))
    if (!localCapsule) return familyCapsule
    consumedLocalIds.add(localCapsule.id)
    const localPhotosById = new Map(
      localCapsule.photos.map((photo) => [photo.id, photo]),
    )
    const durableFamilyPhotos = familyCapsule.photos.map((familyPhoto) => {
      const localPhoto = localPhotosById.get(familyPhoto.id)
      if (!localPhoto || !sameCapsulePhotoOwner(localPhoto, familyPhoto)) return familyPhoto
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
    const localOnlyPhotos = localCapsule.photos
      .filter((photo) => (
        !familyPhotoIds.has(photo.id) && (
          photo.syncStatus === 'pending' ||
          typeof photo.image !== 'string' ||
          typeof photo.thumbnail !== 'string'
        )
      ))
      .map((photo) => ({ ...photo, capsuleId: familyCapsule.id }))
    const pendingPhotoCount = localOnlyPhotos.filter(
      ({ syncStatus }) => syncStatus === 'pending',
    ).length
    const syncedVisiblePhotoCount = durableFamilyPhotos.length +
      localOnlyPhotos.length - pendingPhotoCount
    return {
      ...familyCapsule,
      photos: [...durableFamilyPhotos, ...localOnlyPhotos]
        .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)),
      totalPhotoCount: Math.max(
        familyCapsule.totalPhotoCount ?? familyCapsule.photos.length,
        syncedVisiblePhotoCount,
      ) + pendingPhotoCount,
    }
  })

  return orderCapsules([
    ...mergedFamily,
    ...localCapsules.filter(({ id }) => !consumedLocalIds.has(id) && !familyCapsules.some(({ id: familyId }) => familyId === id)),
  ])
}
