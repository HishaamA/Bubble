import { describe, expect, it } from 'vitest'
import {
  createCameraBasis,
  directionToEquirectangular,
  resolveFrameCalibration,
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

  it('keeps the calibrated optical centre when frames are sampled down', () => {
    expect(resolveFrameCalibration({
      width: 2000,
      height: 1000,
      intrinsics: [1200, 0, 1080, 0, 1180, 460, 0, 0, 1],
    }, 1000, 500)).toEqual({
      fx: 600,
      fy: 590,
      cx: 540,
      cy: 230,
    })
  })

  it('falls back to the image centre when old frames have no intrinsics', () => {
    expect(resolveFrameCalibration({
      width: 1920,
      height: 1080,
      horizontalFovDegrees: 68,
    }, 720, 405)).toMatchObject({
      cx: 359.5,
      cy: 202,
    })
  })

  it('rotates an off-centre calibration with a legacy quarter-turn frame', () => {
    expect(resolveFrameCalibration({
      width: 2000,
      height: 1000,
      rotationDegrees: 90,
      intrinsics: [1200, 0, 1080, 0, 1180, 460, 0, 0, 1],
    }, 500, 1000)).toEqual({
      fx: 590,
      fy: 600,
      cx: 269.5,
      cy: 540,
    })
  })
})
