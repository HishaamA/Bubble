import { describe, expect, it } from 'vitest'
import {
  calculateAdaptiveSeamMix,
  calculateRobustFrameLuma,
  createCameraBasis,
  directionToEquirectangular,
  resolveExposureScales,
  resolveFrameCalibration,
  resolveFrameCameraBasis,
  resolveFrameOrientation,
  solveOverlapExposureScales,
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

describe('guided panorama exposure and seams', () => {
  it('uses an order-independent median exposure reference', () => {
    const original = [52, 96, 104, 112, 220]
    const reordered = [220, 104, 52, 112, 96]
    const originalByLuma = new Map(
      original.map((luma, index) => [luma, resolveExposureScales(original)[index]]),
    )

    reordered.forEach((luma, index) => {
      expect(resolveExposureScales(reordered)[index]).toBeCloseTo(
        originalByLuma.get(luma) as number,
      )
    })
  })

  it('bounds exposure correction when one frame is an outlier', () => {
    const scales = resolveExposureScales([8, 96, 100, 104, 245])

    expect(scales[0]).toBe(1.22)
    expect(scales[2]).toBeCloseTo(1)
    expect(scales[4]).toBe(0.82)
  })

  it('prefers overlap-local evidence over different scene brightness', () => {
    const scales = solveOverlapExposureScales(
      [45, 120, 230],
      [
        {
          firstFrameIndex: 0,
          secondFrameIndex: 1,
          logGainDifference: 0,
          sampleCount: 400,
        },
        {
          firstFrameIndex: 1,
          secondFrameIndex: 2,
          logGainDifference: 0,
          sampleCount: 400,
        },
      ],
    )

    expect(scales[0]).toBeCloseTo(1)
    expect(scales[1]).toBeCloseTo(1)
    expect(scales[2]).toBeCloseTo(1)
  })

  it('solves and bounds relative gain from shared pixels', () => {
    const scales = solveOverlapExposureScales(
      [100, 100],
      [{
        firstFrameIndex: 0,
        secondFrameIndex: 1,
        logGainDifference: Math.log(2),
        sampleCount: 600,
      }],
    )

    expect(scales[0]).toBeCloseTo(1.22)
    expect(scales[1]).toBeCloseTo(0.82)
  })

  it('uses conservative global exposure only for an isolated frame', () => {
    const scales = solveOverlapExposureScales(
      [100, 100, 200],
      [{
        firstFrameIndex: 0,
        secondFrameIndex: 1,
        logGainDifference: 0,
        sampleCount: 300,
      }],
    )

    expect(scales[0]).toBeCloseTo(1)
    expect(scales[1]).toBeCloseTo(1)
    expect(scales[2]).toBe(0.82)
  })

  it('trims isolated black and white pixels from frame brightness', () => {
    const data = new Uint8ClampedArray(1600 * 4)
    for (let pixel = 0; pixel < 1600; pixel += 1) {
      const value = pixel < 128 ? 0 : pixel >= 1472 ? 255 : 120
      data[pixel * 4] = value
      data[pixel * 4 + 1] = value
      data[pixel * 4 + 2] = value
      data[pixel * 4 + 3] = 255
    }

    expect(calculateRobustFrameLuma(data)).toBe(120)
  })

  it('keeps the winning source unchanged away from a seam', () => {
    expect(calculateAdaptiveSeamMix(
      255,
      150,
      120,
      100,
      80,
      121,
      101,
      81,
    )).toBe(0)
  })

  it('feathers visually matching sources at a narrow ownership seam', () => {
    const mix = calculateAdaptiveSeamMix(
      255,
      252,
      120,
      100,
      80,
      124,
      102,
      82,
    )

    expect(mix).toBeGreaterThan(0.4)
    expect(mix).toBeLessThanOrEqual(0.5)
  })

  it('does not blend mismatched overlap content into a ghost', () => {
    expect(calculateAdaptiveSeamMix(
      255,
      254,
      230,
      210,
      190,
      25,
      45,
      65,
    )).toBe(0)
  })
})
