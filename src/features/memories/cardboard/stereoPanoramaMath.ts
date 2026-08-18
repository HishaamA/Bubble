const DEGREES_TO_RADIANS = Math.PI / 180

export type Quaternion = readonly [number, number, number, number]

export interface StereoViewport {
  x: number
  y: number
  width: number
  height: number
  opticalCenter: number
}

export const STEREO_LENS_WIDTH_FRACTION = 0.38
export const STEREO_LENS_HEIGHT_FRACTION = 0.90

export function clampOpticalCenterShift(shift: number): number {
  if (!Number.isFinite(shift)) return 0
  return Math.max(0, Math.min(0.18, shift))
}

export function resolveStereoViewports(
  canvasWidth: number,
  canvasHeight: number,
  opticalCenterShift: number,
): readonly [StereoViewport, StereoViewport] {
  const width = Math.max(2, Math.floor(canvasWidth))
  const height = Math.max(1, Math.floor(canvasHeight))
  const eyeWidth = Math.max(
    1,
    Math.floor(width * STEREO_LENS_WIDTH_FRACTION),
  )
  const eyeHeight = Math.max(
    1,
    Math.floor(height * STEREO_LENS_HEIGHT_FRACTION),
  )
  const leftEyeX = Math.max(0, Math.round(width * 0.25 - eyeWidth / 2))
  const rightEyeX = width - leftEyeX - eyeWidth
  const eyeY = Math.max(0, Math.floor((height - eyeHeight) / 2))
  const shiftNdc = clampOpticalCenterShift(opticalCenterShift) * 2
  return [
    {
      x: leftEyeX,
      y: eyeY,
      width: eyeWidth,
      height: eyeHeight,
      opticalCenter: shiftNdc,
    },
    {
      x: rightEyeX,
      y: eyeY,
      width: eyeWidth,
      height: eyeHeight,
      opticalCenter: -shiftNdc,
    },
  ]
}

export function evenPixelWidth(width: number): number {
  const rounded = Math.max(2, Math.round(width))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

export function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export function invertQuaternion(q: Quaternion): Quaternion {
  const [x, y, z, w] = q
  const lengthSquared = x * x + y * y + z * z + w * w
  if (lengthSquared === 0) return [0, 0, 0, 1]
  return [-x / lengthSquared, -y / lengthSquared, -z / lengthSquared, w / lengthSquared]
}

function normalizeQuaternion(q: Quaternion): Quaternion {
  const [x, y, z, w] = q
  const length = Math.hypot(x, y, z, w)
  return length === 0 ? [0, 0, 0, 1] : [x / length, y / length, z / length, w / length]
}

function axisAngleQuaternion(x: number, y: number, z: number, radians: number): Quaternion {
  const half = radians / 2
  const sine = Math.sin(half)
  return [x * sine, y * sine, z * sine, Math.cos(half)]
}

/** Converts W3C Z-X'-Y'' device angles to a camera local-to-world pose. */
export function deviceOrientationQuaternion(
  alphaDegrees: number,
  betaDegrees: number,
  gammaDegrees: number,
  screenAngleDegrees: number,
): Quaternion {
  const alpha = alphaDegrees * DEGREES_TO_RADIANS
  const beta = betaDegrees * DEGREES_TO_RADIANS
  const gamma = -gammaDegrees * DEGREES_TO_RADIANS
  const c1 = Math.cos(beta / 2)
  const c2 = Math.cos(alpha / 2)
  const c3 = Math.cos(gamma / 2)
  const s1 = Math.sin(beta / 2)
  const s2 = Math.sin(alpha / 2)
  const s3 = Math.sin(gamma / 2)
  const phone: Quaternion = [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ]
  const cameraCorrection = axisAngleQuaternion(1, 0, 0, -Math.PI / 2)
  const screenCorrection = axisAngleQuaternion(
    0,
    0,
    1,
    -screenAngleDegrees * DEGREES_TO_RADIANS,
  )
  return normalizeQuaternion(
    multiplyQuaternions(
      multiplyQuaternions(phone, cameraCorrection),
      screenCorrection,
    ),
  )
}

/** Positive panorama yaw looks right (+X); positive pitch looks upward (+Y). */
export function viewQuaternion(yawDegrees: number, pitchDegrees: number): Quaternion {
  const yaw = axisAngleQuaternion(0, 1, 0, -yawDegrees * DEGREES_TO_RADIANS)
  const pitch = axisAngleQuaternion(1, 0, 0, pitchDegrees * DEGREES_TO_RADIANS)
  return normalizeQuaternion(multiplyQuaternions(yaw, pitch))
}

export function relativeDeviceViewQuaternion(
  initialView: Quaternion,
  initialDevice: Quaternion,
  currentDevice: Quaternion,
): Quaternion {
  const worldDelta = multiplyQuaternions(currentDevice, invertQuaternion(initialDevice))
  return normalizeQuaternion(multiplyQuaternions(worldDelta, initialView))
}

/** Column-major rotation matrix accepted directly by WebGL uniformMatrix3fv. */
export function quaternionToMatrix3(q: Quaternion): Float32Array {
  const [x, y, z, w] = normalizeQuaternion(q)
  const xx = x * x
  const xy = x * y
  const xz = x * z
  const xw = x * w
  const yy = y * y
  const yz = y * z
  const yw = y * w
  const zz = z * z
  const zw = z * w
  return new Float32Array([
    1 - 2 * (yy + zz), 2 * (xy + zw), 2 * (xz - yw),
    2 * (xy - zw), 1 - 2 * (xx + zz), 2 * (yz + xw),
    2 * (xz + yw), 2 * (yz - xw), 1 - 2 * (xx + yy),
  ])
}
