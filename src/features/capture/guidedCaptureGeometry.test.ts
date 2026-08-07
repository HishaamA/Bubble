import { describe, expect, it } from 'vitest'
import {
  projectGuideTarget,
  STANDARD_GUIDE_TARGETS,
} from './guidedCaptureGeometry'

describe('guided capture projection', () => {
  it('places an aligned target at the reticle centre', () => {
    const projection = projectGuideTarget(
      { id: 'front', yaw: 45, pitch: 30 },
      { yaw: 45, pitch: 30 },
    )
    expect(projection).toMatchObject({
      visible: true,
      left: 50,
      top: 50,
    })
    expect(projection.centreDistance).toBeCloseTo(0)
  })

  it('wraps targets across the 360-degree seam', () => {
    const projection = projectGuideTarget(
      { id: 'seam', yaw: 2, pitch: 0 },
      { yaw: 358, pitch: 0 },
    )
    expect(projection.visible).toBe(true)
    expect(projection.left).toBeGreaterThan(50)
    expect(projection.left).toBeLessThan(57)
  })

  it('keeps dots outside the physical camera arc out of the current view', () => {
    expect(projectGuideTarget(
      { id: 'next-arc', yaw: 45, pitch: 0 },
      { yaw: 0, pitch: 0 },
    ).visible).toBe(false)

    expect(projectGuideTarget(
      { id: 'behind', yaw: 180, pitch: 0 },
      { yaw: 0, pitch: 0 },
    ).visible).toBe(false)
  })

  it('places ceiling and floor targets in separate physical views', () => {
    const ceiling = { id: 'ceiling', yaw: 0, pitch: 82 }
    const floor = { id: 'floor', yaw: 0, pitch: -82 }

    expect(projectGuideTarget(ceiling, { yaw: 0, pitch: 0 }).visible).toBe(false)
    expect(projectGuideTarget(floor, { yaw: 0, pitch: 0 }).visible).toBe(false)
    expect(projectGuideTarget(ceiling, { yaw: 0, pitch: 82 })).toMatchObject({
      visible: true,
      left: 50,
      top: 50,
    })
    expect(projectGuideTarget(floor, { yaw: 0, pitch: -82 })).toMatchObject({
      visible: true,
      left: 50,
      top: 50,
    })
  })

  it('allows the native camera field of view to tune the projection', () => {
    const target = { id: 'wide-only', yaw: 42, pitch: 0 }
    expect(projectGuideTarget(target, { yaw: 0, pitch: 0 }).visible).toBe(false)
    expect(projectGuideTarget(
      target,
      { yaw: 0, pitch: 0 },
      { horizontalFovDegrees: 100 },
    ).visible).toBe(true)
  })

  it('spreads a 34-shot standard sphere across distinct camera arcs', () => {
    const visibleFromFront = STANDARD_GUIDE_TARGETS.filter((target) =>
      projectGuideTarget(target, { yaw: 0, pitch: 0 }).visible,
    )

    expect(STANDARD_GUIDE_TARGETS).toHaveLength(34)
    expect(new Set(STANDARD_GUIDE_TARGETS.map(({ id }) => id)).size).toBe(34)
    expect(Math.max(...STANDARD_GUIDE_TARGETS.map(({ pitch }) => pitch))).toBe(82)
    expect(Math.min(...STANDARD_GUIDE_TARGETS.map(({ pitch }) => pitch))).toBe(-82)
    expect(visibleFromFront.length).toBeGreaterThan(0)
    expect(visibleFromFront.length).toBeLessThanOrEqual(5)
  })

  it('uses the native 5/7/8/7/5 standard ring distribution', () => {
    const ringCounts = [55, 27, 0, -27, -55].map((pitch) =>
      STANDARD_GUIDE_TARGETS.filter((target) => target.pitch === pitch).length,
    )

    expect(ringCounts).toEqual([5, 7, 8, 7, 5])
    expect(STANDARD_GUIDE_TARGETS.filter(({ pitch }) => pitch === 55)[0]?.yaw).toBe(36)
    expect(STANDARD_GUIDE_TARGETS.filter(({ pitch }) => pitch === 27)[0]?.yaw).toBe(0)
    expect(STANDARD_GUIDE_TARGETS.filter(({ pitch }) => pitch === 0)[0]?.yaw).toBe(22.5)
    expect(STANDARD_GUIDE_TARGETS.filter(({ pitch }) => pitch === -27)[0]?.yaw)
      .toBeCloseTo(360 / 14)
    expect(STANDARD_GUIDE_TARGETS.filter(({ pitch }) => pitch === -55)[0]?.yaw).toBe(0)
  })
})
