import type { CapsulePhoto } from '../capsules/types'

type CapsulePhotoIdentity = Pick<CapsulePhoto, 'id' | 'capsuleId' | 'image' | 'thumbnail'>

/**
 * One upload may belong to a weekly and special Capsule. Its content ID is the
 * Journal identity, not its memberships. Pick the lowest collection ID so
 * response order never changes the route, while retaining offline Blob media.
 * Callers must enforce their own account and unlock boundaries first.
 */
export function canonicalCapsulePhotos<Photo extends CapsulePhotoIdentity>(
  photos: readonly Photo[],
): Photo[] {
  const byId = new Map<string, Photo>()
  for (const photo of photos) {
    const current = byId.get(photo.id)
    if (!current) {
      byId.set(photo.id, photo)
      continue
    }
    const canonical = photo.capsuleId < current.capsuleId ? photo : current
    const other = canonical === photo ? current : photo
    byId.set(photo.id, {
      ...canonical,
      image: canonical.image instanceof Blob ? canonical.image : other.image instanceof Blob ? other.image : canonical.image,
      thumbnail: canonical.thumbnail instanceof Blob ? canonical.thumbnail : other.thumbnail instanceof Blob ? other.thumbnail : canonical.thumbnail,
    })
  }
  return [...byId.values()]
}
