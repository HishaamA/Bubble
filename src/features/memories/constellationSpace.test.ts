import { describe, expect, it } from 'vitest'
import {
  calculateCenterDepth,
  calculateInitialConstellationPan,
  calculateConstellationPan,
} from './constellationSpace'
import { memories } from './memories'

describe('calculateConstellationPan', () => {
  it('follows the drag while keeping the constellation within reach', () => {
    const pan = calculateConstellationPan({
      origin: { x: 12, y: -8 },
      delta: { x: 1_000, y: 1_000 },
      field: { width: 360, height: 560 },
      world: { width: 594, height: 896 },
    })

    expect(pan.x).toBeGreaterThan(0)
    expect(pan.y).toBeGreaterThan(0)
    expect(pan.x).toBe(180)
    expect(pan.y).toBe(280)
  })

  it('clamps equally once a drag moves beyond the explorable space', () => {
    const field = { width: 360, height: 560 }
    const world = { width: 594, height: 896 }
    const edge = calculateConstellationPan({
      origin: { x: 0, y: 0 },
      delta: { x: -10_000, y: 10_000 },
      field,
      world,
    })
    const farther = calculateConstellationPan({
      origin: { x: 0, y: 0 },
      delta: { x: -20_000, y: 20_000 },
      field,
      world,
    })

    expect(edge.x).toBeLessThan(0)
    expect(edge.y).toBeGreaterThan(0)
    expect(farther).toEqual(edge)
  })

  it('centers the oversized world initially and exposes its full focus range', () => {
    const field = { width: 360, height: 560 }
    const world = { width: 594, height: 896 }
    const initial = calculateInitialConstellationPan({ field, world })

    expect(initial).toEqual({ x: -117, y: -168 })
    expect(
      calculateConstellationPan({
        origin: initial,
        delta: { x: -10_000, y: -10_000 },
        field,
        world,
      }),
    ).toEqual({ x: -414, y: -616 })
  })

  it('can bring every positioned equal-size memory through screen center', () => {
    const field = { width: 360, height: 560 }
    const world = { width: 594, height: 896 }
    const bubbleSize = 80

    memories.forEach((memory) => {
      const bubbleCenter = {
        x:
          (Number.parseFloat(memory.position.left) / 100) * world.width +
          bubbleSize / 2,
        y:
          (Number.parseFloat(memory.position.top) / 100) * world.height +
          bubbleSize / 2,
      }
      const requiredPan = {
        x: field.width / 2 - bubbleCenter.x,
        y: field.height / 2 - bubbleCenter.y,
      }

      expect(
        calculateConstellationPan({
          origin: { x: 0, y: 0 },
          delta: requiredPan,
          field,
          world,
        }),
      ).toEqual({
        x: Math.round(requiredPan.x * 100) / 100,
        y: Math.round(requiredPan.y * 100) / 100,
      })
    })
  })
})

describe('calculateCenterDepth', () => {
  it('brings a centered bubble forward and lets an edge bubble recede', () => {
    const field = { width: 360, height: 560 }
    const centered = calculateCenterDepth({
      field,
      bubble: { x: 150, y: 250, size: 60 },
      pan: { x: 0, y: 0 },
    })
    const peripheral = calculateCenterDepth({
      field,
      bubble: { x: -30, y: -30, size: 60 },
      pan: { x: 0, y: 0 },
    })

    expect(centered.proximity).toBe(1)
    expect(centered.scale).toBeGreaterThanOrEqual(2.5)
    expect(centered.proximity).toBeGreaterThan(peripheral.proximity)
    expect(centered.scale).toBeGreaterThan(peripheral.scale)
    expect(peripheral.scale).toBeLessThan(0.8)
  })

  it('accounts for the world pan when measuring visual depth', () => {
    const input = {
      field: { width: 360, height: 560 },
      bubble: { x: 40, y: 250, size: 60 },
    }
    const before = calculateCenterDepth({ ...input, pan: { x: 0, y: 0 } })
    const after = calculateCenterDepth({ ...input, pan: { x: 110, y: 0 } })

    expect(after.proximity).toBeGreaterThan(before.proximity)
    expect(after.scale).toBeGreaterThan(before.scale)
  })

  it('lets a different equal-size bubble become largest after panning', () => {
    const field = { width: 360, height: 560 }
    const first = { x: 257, y: 408, size: 80 }
    const second = { x: 500, y: 408, size: 80 }
    const initialPan = { x: -117, y: -168 }
    const secondFocusedPan = { x: -360, y: -168 }

    const firstInitially = calculateCenterDepth({
      field,
      bubble: first,
      pan: initialPan,
    })
    const secondInitially = calculateCenterDepth({
      field,
      bubble: second,
      pan: initialPan,
    })
    const firstAfterPan = calculateCenterDepth({
      field,
      bubble: first,
      pan: secondFocusedPan,
    })
    const secondAfterPan = calculateCenterDepth({
      field,
      bubble: second,
      pan: secondFocusedPan,
    })

    expect(firstInitially.scale).toBeGreaterThan(secondInitially.scale)
    expect(secondAfterPan.scale).toBeGreaterThan(firstAfterPan.scale)
    expect(firstInitially.scale).toBe(secondAfterPan.scale)
  })
})
