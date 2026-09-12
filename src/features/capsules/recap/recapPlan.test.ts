import { describe, expect, it } from 'vitest'
import type { CapsulePhoto } from '../types'
import {
  buildCapsuleRecapPlan,
  CAPSULE_RECAP_FRAME_RATE,
  CAPSULE_RECAP_FRAMES_PER_PHOTO,
  CAPSULE_RECAP_PHOTO_DURATION_MS,
  CAPSULE_RECAP_MAX_PHOTOS,
  orderCapsuleRecapPhotos,
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
  it('combines all contributors with stable order for equal capture times', () => {
    const photos = [
      { ...photo('b', '2026-08-25T12:00:00.000Z'), contributorName: 'Mum' },
      { ...photo('a', '2026-08-25T12:00:00.000Z'), contributorName: 'Simreen' },
    ]
    expect(buildCapsuleRecapPlan(photos).frames.map(({ photoId }) => photoId)).toEqual(['a', 'b'])
    expect(buildCapsuleRecapPlan([...photos].reverse())).toEqual(buildCapsuleRecapPlan(photos))
    expect(photos.map(({ id }) => id)).toEqual(['b', 'a'])
  })

  it('does not truncate large family capsules during playback or silently export a partial film', () => {
    const photos = Array.from({ length: CAPSULE_RECAP_MAX_PHOTOS + 1 }, (_, index) => photo(String(index), '2026-08-25T12:00:00.000Z'))
    expect(orderCapsuleRecapPhotos(photos)).toHaveLength(151)
    expect(() => buildCapsuleRecapPlan(photos)).toThrow('Video export supports up to 150')
  })
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
