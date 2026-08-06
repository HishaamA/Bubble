import { describe, expect, it } from 'vitest'
import { projectGuideTarget } from './guidedCaptureGeometry'

describe('guided capture projection', () => {
  it('places an aligned target at the reticle centre', () => {
    expect(projectGuideTarget(
      { id: 'front', yaw: 45, pitch: 30 },
      { yaw: 45, pitch: 30 },
    )).toMatchObject({
      visible: true,
      left: 50,
      top: 50,
      centreDistance: 0,
    })
  })

  it('wraps targets across the 360-degree seam', () => {
    const projection = projectGuideTarget(
      { id: 'seam', yaw: 2, pitch: 0 },
      { yaw: 358, pitch: 0 },
    )
    expect(projection.visible).toBe(true)
    expect(projection.left).toBeGreaterThan(50)
    expect(projection.left).toBeLessThan(54)
  })
})
