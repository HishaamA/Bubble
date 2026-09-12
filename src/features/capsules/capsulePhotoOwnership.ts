import type { CapsulePhoto } from './types'

/** A renewed signed URL may reuse local bytes only for the same contributor. */
export function sameCapsulePhotoOwner(local: CapsulePhoto, remote: CapsulePhoto) {
  if (local.uploaderId && remote.uploaderId) return local.uploaderId === remote.uploaderId
  return local.ownedByCurrentUser && remote.ownedByCurrentUser
}
