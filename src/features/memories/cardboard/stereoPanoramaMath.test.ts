import { describe, expect, it } from 'vitest'
import {
  deviceOrientationQuaternion,
  evenPixelWidth,
  invertQuaternion,
  multiplyQuaternions,
  quaternionToMatrix3,
  relativeDeviceViewQuaternion,
  resolveStereoViewports,
  viewQuaternion,
} from './stereoPanoramaMath'

function transformDirection(matrix: Float32Array, [x, y, z]: readonly [number, number, number]) {
  return [
    matrix[0] * x + matrix[3] * y + matrix[6] * z,
    matrix[1] * x + matrix[4] * y + matrix[7] * z,
    matrix[2] * x + matrix[5] * y + matrix[8] * z,
  ] as const
}

function expectMatricesClose(actual: Float32Array, expected: Float32Array) {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 5))
}

describe('stereo panorama geometry', () => {
  it('uses equal viewports with symmetric inward optical centers', () => {
    expect(resolveStereoViewports(844, 390, 0.055)).toEqual([
      {
        x: 51,
        y: 19,
        width: 320,
        height: 351,
        opticalCenter: 0.11,
      },
      {
        x: 473,
        y: 19,
        width: 320,
        height: 351,
        opticalCenter: -0.11,
      },
    ])
  })

  it('keeps the two optical centers at the physical screen quarter points', () => {
    const [left, right] = resolveStereoViewports(1170, 540, 0)
    expect(left.width).toBe(right.width)
    expect(Math.abs(left.x + left.width / 2 - 1170 * 0.25)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(right.x + right.width / 2 - 1170 * 0.75)).toBeLessThanOrEqual(0.5)
    expect(right.x - (left.x + left.width)).toBeGreaterThan(0)
    expect(right.x + right.width).toBe(1170 - left.x)
  })

  it('keeps tiny buffers valid and symmetric', () => {
    expect(resolveStereoViewports(2, 1, 0)).toEqual([
      { x: 0, y: 0, width: 1, height: 1, opticalCenter: 0 },
      { x: 1, y: 0, width: 1, height: 1, opticalCenter: -0 },
    ])
  })

  it.each([
    [667, 375],
    [844, 390],
    [852, 393],
    [932, 430],
  ])('keeps black surround and a center rail at %sx%s', (width, height) => {
    const [left, right] = resolveStereoViewports(width, height, 0)
    const outerLeft = left.x
    const outerRight = width - (right.x + right.width)
    const centerRail = right.x - (left.x + left.width)

    expect(outerLeft).toBe(outerRight)
    expect(outerLeft).toBeGreaterThan(0)
    expect(centerRail).toBeGreaterThanOrEqual(44)
    expect(left.y).toBeGreaterThan(0)
    expect(height - (left.y + left.height)).toBeGreaterThan(0)
  })

  it('makes the drawing buffer even', () => {
    expect(evenPixelWidth(1171)).toBe(1170)
    expect(evenPixelWidth(1172)).toBe(1172)
  })

  it('calibrates the first sample to the requested scene view', () => {
    const base = viewQuaternion(24, -8)
    const first = deviceOrientationQuaternion(12, 80, -4, 90)
    expectMatricesClose(
      quaternionToMatrix3(relativeDeviceViewQuaternion(base, first, first)),
      quaternionToMatrix3(base),
    )
  })

  it('composes device motion in world space before the scene view', () => {
    const base = viewQuaternion(31, 14)
    const first = deviceOrientationQuaternion(12, 78, -7, 90)
    const current = deviceOrientationQuaternion(47, 63, 19, 90)
    const expected = multiplyQuaternions(
      multiplyQuaternions(current, invertQuaternion(first)),
      base,
    )
    expectMatricesClose(
      quaternionToMatrix3(relativeDeviceViewQuaternion(base, first, current)),
      quaternionToMatrix3(expected),
    )
  })

  it('maps positive yaw right and positive pitch upward', () => {
    const yaw = transformDirection(quaternionToMatrix3(viewQuaternion(90, 0)), [0, 0, -1])
    const pitch = transformDirection(quaternionToMatrix3(viewQuaternion(0, 45)), [0, 0, -1])
    expect(yaw[0]).toBeCloseTo(1, 5)
    expect(yaw[2]).toBeCloseTo(0, 5)
    expect(pitch[1]).toBeGreaterThan(0.7)
  })

  it('retains roll in the shared camera matrix', () => {
    const first = deviceOrientationQuaternion(0, 90, 0, 90)
    const rolled = deviceOrientationQuaternion(10, 70, 30, 90)
    const matrix = quaternionToMatrix3(
      relativeDeviceViewQuaternion(viewQuaternion(0, 0), first, rolled),
    )
    expect(Math.abs(matrix[1])).toBeGreaterThan(0.05)
  })
})
