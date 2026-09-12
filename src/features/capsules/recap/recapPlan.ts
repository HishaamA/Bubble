import type { CapsulePhoto } from '../types'

export const CAPSULE_RECAP_FRAME_RATE = 30
export const CAPSULE_RECAP_FRAMES_PER_PHOTO = 6
export const CAPSULE_RECAP_PHOTO_DURATION_MS = 200
export const CAPSULE_RECAP_MAX_PHOTOS = 150

export type CapsuleRecapFrame = {
  photoId: string
  sourceIndex: number
  firstFrame: number
  frameCount: number
  startsAtMs: number
  durationMs: number
}

export type CapsuleRecapPlan = {
  frames: CapsuleRecapFrame[]
  frameRate: number
  framesPerPhoto: number
  durationMs: number
}

/** The same shared rows produce the same film on every family member's device. */
export function orderCapsuleRecapPhotos(photos: CapsulePhoto[]) {
  return [...photos].sort((left, right) => (
    left.capturedAt.localeCompare(right.capturedAt) || left.id.localeCompare(right.id)
  ))
}

/** Builds a deterministic, chronologically ordered frame plan for a recap. */
export function buildCapsuleRecapPlan(
  photos: CapsulePhoto[],
): CapsuleRecapPlan {
  // Never silently save only the first part of a family's Capsule. Playback
  // remains unbounded; the native codecs and browser recorder share this cap.
  if (photos.length > CAPSULE_RECAP_MAX_PHOTOS) {
    throw new Error(`This Capsule has ${photos.length} photos. Video export supports up to ${CAPSULE_RECAP_MAX_PHOTOS}; every photo is still available in the family recap.`)
  }
  const ordered = orderCapsuleRecapPhotos(photos)

  const frames = ordered.map((photo, sourceIndex) => ({
    photoId: photo.id,
    sourceIndex,
    firstFrame: sourceIndex * CAPSULE_RECAP_FRAMES_PER_PHOTO,
    frameCount: CAPSULE_RECAP_FRAMES_PER_PHOTO,
    startsAtMs: sourceIndex * CAPSULE_RECAP_PHOTO_DURATION_MS,
    durationMs: CAPSULE_RECAP_PHOTO_DURATION_MS,
  }))

  return {
    frames,
    frameRate: CAPSULE_RECAP_FRAME_RATE,
    framesPerPhoto: CAPSULE_RECAP_FRAMES_PER_PHOTO,
    durationMs: frames.length * CAPSULE_RECAP_PHOTO_DURATION_MS,
  }
}
