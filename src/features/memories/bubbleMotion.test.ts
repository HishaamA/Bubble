import { describe, expect, it } from 'vitest'
import { calculateBubbleMotion } from './bubbleMotion'

const field = { width: 360, height: 560 }

describe('calculateBubbleMotion', () => {
  it('pushes a nearby bubble away from a pressed pointer', () => {
    const motion = calculateBubbleMotion({
      pointer: { x: 100, y: 100 },
      field,
      bubble: { x: 115, y: 85, size: 60 },
      order: 2,
      pressed: true,
    })

    expect(motion.proximity).toBeGreaterThan(0.5)
    expect(motion.x).toBeGreaterThan(0)
    expect(motion.scale).toBeGreaterThan(1)
  })

  it('keeps distant bubbles calm while retaining subtle depth parallax', () => {
    const motion = calculateBubbleMotion({
      pointer: { x: 20, y: 20 },
      field,
      bubble: { x: 285, y: 460, size: 54 },
      order: 4,
      pressed: false,
    })

    expect(motion.proximity).toBe(0)
    expect(motion.scale).toBe(1)
    expect(Math.abs(motion.x)).toBeLessThan(6)
    expect(Math.abs(motion.y)).toBeLessThan(5)
  })

  it('returns a stable resting state for an unmeasured field', () => {
    expect(
      calculateBubbleMotion({
        pointer: { x: 0, y: 0 },
        field: { width: 0, height: 0 },
        bubble: { x: 0, y: 0, size: 0 },
        order: 0,
        pressed: false,
      }),
    ).toEqual({ x: 0, y: 0, scale: 1, proximity: 0 })
  })

  it('does not snap an intentionally overflowing large bubble inward', () => {
    const motion = calculateBubbleMotion({
      pointer: { x: 180, y: 150 },
      field: { width: 360, height: 260 },
      bubble: { x: 90, y: 120, size: 224 },
      order: 4,
      pressed: false,
    })

    expect(motion.y).toBeGreaterThanOrEqual(0)
    expect(Math.abs(motion.y)).toBeLessThan(20)
  })
})
