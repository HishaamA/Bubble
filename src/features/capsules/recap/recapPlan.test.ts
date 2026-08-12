import { describe, expect, it } from 'vitest'
import type { CapsulePhoto } from '../types'
import {
  buildCapsuleRecapPlan,
  CAPSULE_RECAP_FRAME_RATE,
  CAPSULE_RECAP_FRAMES_PER_PHOTO,
  CAPSULE_RECAP_PHOTO_DURATION_MS,
} from './recapPlan'

function photo(id: string, capturedAt: string): CapsulePhoto {
  return {
    id,
    capsuleId: 'weekly-one',
    image: `/${id}.jpg`,
    thumbnail: `/${id}-thumb.jpg`,
    width: 900,
    height: 1200,
    caption: id,
    capturedAt,
    contributorName: 'Family',
    ownedByCurrentUser: false,
  }
}

describe('buildCapsuleRecapPlan', () => {
  it('orders photos chronologically and holds each for exactly 0.2 seconds', () => {
    const plan = buildCapsuleRecapPlan([
      photo('third', '2026-08-27T12:00:00.000Z'),
      photo('first', '2026-08-25T12:00:00.000Z'),
      photo('second', '2026-08-26T12:00:00.000Z'),
    ])

    expect(plan.frameRate).toBe(CAPSULE_RECAP_FRAME_RATE)
    expect(plan.framesPerPhoto).toBe(CAPSULE_RECAP_FRAMES_PER_PHOTO)
    expect(plan.frames.map(({ photoId }) => photoId)).toEqual([
      'first',
      'second',
      'third',
    ])
    expect(plan.frames.every(({ frameCount }) => frameCount === 6)).toBe(true)
    expect(plan.frames.map(({ startsAtMs }) => startsAtMs)).toEqual([0, 200, 400])
    expect(plan.durationMs).toBe(3 * CAPSULE_RECAP_PHOTO_DURATION_MS)
  })
})
