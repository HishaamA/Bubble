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

export function buildCapsuleRecapPlan(
  photos: CapsulePhoto[],
): CapsuleRecapPlan {
  const ordered = [...photos]
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
    .slice(0, CAPSULE_RECAP_MAX_PHOTOS)

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
