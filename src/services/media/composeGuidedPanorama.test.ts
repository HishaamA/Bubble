import { describe, expect, it } from 'vitest'
import {
  createCameraBasis,
  directionToEquirectangular,
  resolveFrameCameraBasis,
  resolveFrameOrientation,
} from './composeGuidedPanorama'

describe('guided panorama geometry', () => {
  it('maps the initial forward direction to the panorama centre', () => {
    expect(directionToEquirectangular([0, 0, 1], 2048, 1024)).toEqual({
      x: 1024,
      y: 512,
    })
  })

  it('wraps the rear direction to the horizontal seam', () => {
    const coordinate = directionToEquirectangular([0, 0, -1], 2048, 1024)
    expect(coordinate.x).toBe(0)
    expect(coordinate.y).toBe(512)
  })

  it('uses the actual shutter pose over the nearby guide target', () => {
    expect(resolveFrameOrientation({
      width: 1920,
      height: 1440,
      targetYawDegrees: 90,
      targetPitchDegrees: 30,
      yaw: 0.2,
      pitch: 0.1,
    })).toEqual({
      yawDegrees: 0.2,
      pitchDegrees: 0.1,
      rollDegrees: 0,
    })
  })

  it('falls back to guide angles for older frames without shutter pose metadata', () => {
    expect(resolveFrameOrientation({
      width: 1920,
      height: 1440,
      targetYawDegrees: 315,
      targetPitchDegrees: -60,
    })).toEqual({
      yawDegrees: 315,
      pitchDegrees: -60,
      rollDegrees: 0,
    })
  })

  it('creates a camera basis that looks toward each guide target', () => {
    const basis = createCameraBasis({
      yawDegrees: 90,
      pitchDegrees: 0,
      rollDegrees: 0,
    })
    expect(basis.forward[0]).toBeCloseTo(1)
    expect(basis.forward[1]).toBeCloseTo(0)
    expect(basis.forward[2]).toBeCloseTo(0)
    expect(basis.right[2]).toBeCloseTo(-1)
    expect(basis.up[1]).toBeCloseTo(1)
  })

  it('preserves the native AR camera matrix instead of quantizing it to a target', () => {
    const basis = resolveFrameCameraBasis({
      width: 1920,
      height: 1440,
      yawDegrees: 0,
      pitchDegrees: 0,
      targetYawDegrees: 0,
      targetPitchDegrees: 0,
      // Column-major native camera transform looking 90 degrees to the right.
      transform: [
        0, 0, 1, 0,
        0, 1, 0, 0,
        -1, 0, 0, 0,
        0, 0, 0, 1,
      ],
    })

    expect(basis.forward[0]).toBeCloseTo(1)
    expect(basis.forward[1]).toBeCloseTo(0)
    expect(basis.forward[2]).toBeCloseTo(0)
    expect(basis.right[2]).toBeCloseTo(-1)
    expect(basis.up[1]).toBeCloseTo(1)
  })
})
