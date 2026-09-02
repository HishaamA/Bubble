const DEGREES_TO_RADIANS = Math.PI / 180

export type Quaternion = readonly [number, number, number, number]

export interface StereoViewport {
  x: number
  y: number
  width: number
  height: number
  opticalCenter: number
}

export type StereoViewportProfile = 'ios-reference' | 'youtube-fallback'

export const STEREO_LENS_WIDTH_FRACTION = 0.38
export const STEREO_LENS_HEIGHT_FRACTION = 0.90
export const YOUTUBE_FALLBACK_LENS_WIDTH_FRACTION = 0.40
export const YOUTUBE_FALLBACK_LENS_HEIGHT_FRACTION = 1.0

/** Restricts user/profile optical shifts to a comfortable inward range. */
export function clampOpticalCenterShift(shift: number): number {
  if (!Number.isFinite(shift)) return 0
  return Math.max(0, Math.min(0.18, shift))
}

/**
 * Calculates mirrored eye rectangles and optical centers for one canvas.
 * Dimensions are always positive so callers can pass unsettled layout values.
 */
export function resolveStereoViewports(
  canvasWidth: number,
  canvasHeight: number,
  opticalCenterShift: number,
  profile: StereoViewportProfile = 'ios-reference',
): readonly [StereoViewport, StereoViewport] {
  // The quarter-screen centers model the physical lens positions, not two
  // arbitrary half-width crops. Equal dimensions and mirrored X placement keep
  // projection math symmetric, while the signed NDC optical offset moves both
  // views inward without introducing false binocular parallax into a monoscopic
  // equirectangular source.
  const width = Math.max(2, Math.floor(canvasWidth))
  const height = Math.max(1, Math.floor(canvasHeight))
  const lensWidthFraction =
    profile === 'youtube-fallback'
      ? YOUTUBE_FALLBACK_LENS_WIDTH_FRACTION
      : STEREO_LENS_WIDTH_FRACTION
  const lensHeightFraction =
    profile === 'youtube-fallback'
      ? YOUTUBE_FALLBACK_LENS_HEIGHT_FRACTION
      : STEREO_LENS_HEIGHT_FRACTION
  const leftCenterFraction = profile === 'youtube-fallback' ? 0.30 : 0.25
  const eyeWidth = Math.max(1, Math.floor(width * lensWidthFraction))
  const eyeHeight = Math.max(1, Math.floor(height * lensHeightFraction))
  const leftEyeX = Math.max(
    0,
    Math.round(width * leftCenterFraction - eyeWidth / 2),
  )
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

/** Rounds a canvas buffer width to the nearest usable even pixel count. */
export function evenPixelWidth(width: number): number {
  const rounded = Math.max(2, Math.round(width))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

/** Composes two rotations using Hamilton product order. */
export function multiplyQuaternions(
  first: Quaternion,
  second: Quaternion,
): Quaternion {
  const [firstX, firstY, firstZ, firstW] = first
  const [secondX, secondY, secondZ, secondW] = second
  return [
    firstW * secondX + firstX * secondW + firstY * secondZ - firstZ * secondY,
    firstW * secondY - firstX * secondZ + firstY * secondW + firstZ * secondX,
    firstW * secondZ + firstX * secondY - firstY * secondX + firstZ * secondW,
    firstW * secondW - firstX * secondX - firstY * secondY - firstZ * secondZ,
  ]
}

/** Returns the inverse rotation, with identity as the zero-length fallback. */
export function invertQuaternion(quaternion: Quaternion): Quaternion {
  const [x, y, z, w] = quaternion
  const lengthSquared = x * x + y * y + z * z + w * w
  if (lengthSquared === 0) return [0, 0, 0, 1]
  return [
    -x / lengthSquared,
    -y / lengthSquared,
    -z / lengthSquared,
    w / lengthSquared,
  ]
}

/** Produces a unit quaternion and rejects non-finite sensor input as identity. */
export function normalizeQuaternion(quaternion: Quaternion): Quaternion {
  const [x, y, z, w] = quaternion
  const length = Math.hypot(x, y, z, w)
  return !Number.isFinite(length) || length === 0
    ? [0, 0, 0, 1]
    : [x / length, y / length, z / length, w / length]
}

/** Returns the four-dimensional dot product of two quaternions. */
export function quaternionDot(first: Quaternion, second: Quaternion): number {
  return (
    first[0] * second[0] +
    first[1] * second[1] +
    first[2] * second[2] +
    first[3] * second[3]
  )
}

/** Returns the equivalent antipodal representation of a rotation. */
export function negateQuaternion(quaternion: Quaternion): Quaternion {
  return [
    -quaternion[0],
    -quaternion[1],
    -quaternion[2],
    -quaternion[3],
  ]
}

/** q and -q encode the same rotation; keep interpolation on the short arc. */
export function alignQuaternionHemisphere(
  reference: Quaternion,
  candidate: Quaternion,
): Quaternion {
  return quaternionDot(reference, candidate) < 0
    ? negateQuaternion(candidate)
    : candidate
}

/** Measures the shortest rotational separation between two orientations. */
export function quaternionAngularDistanceDegrees(
  first: Quaternion,
  second: Quaternion,
): number {
  const normalizedFirst = normalizeQuaternion(first)
  const normalizedSecond = normalizeQuaternion(second)
  const dot = Math.min(
    1,
    Math.abs(quaternionDot(normalizedFirst, normalizedSecond)),
  )
  return 2 * Math.acos(dot) / DEGREES_TO_RADIANS
}

/** Pitch of the camera's forward ray, used to keep drag fallback upright. */
export function quaternionViewPitchDegrees(quaternion: Quaternion): number {
  const [x, y, z, w] = normalizeQuaternion(quaternion)
  const forwardY = Math.max(-1, Math.min(1, 2 * (x * w - y * z)))
  return Math.asin(forwardY) / DEGREES_TO_RADIANS
}

/** Numerically stable shortest-arc spherical interpolation. */
export function slerpQuaternions(
  from: Quaternion,
  to: Quaternion,
  amount: number,
): Quaternion {
  const start = normalizeQuaternion(from)
  const end = normalizeQuaternion(alignQuaternionHemisphere(start, to))
  const interpolationAmount = Math.max(
    0,
    Math.min(1, Number.isFinite(amount) ? amount : 0),
  )
  const dot = Math.max(-1, Math.min(1, quaternionDot(start, end)))

  if (dot > 0.9995) {
    return normalizeQuaternion([
      start[0] + (end[0] - start[0]) * interpolationAmount,
      start[1] + (end[1] - start[1]) * interpolationAmount,
      start[2] + (end[2] - start[2]) * interpolationAmount,
      start[3] + (end[3] - start[3]) * interpolationAmount,
    ])
  }

  const theta = Math.acos(dot)
  const sineTheta = Math.sin(theta)
  if (Math.abs(sineTheta) < 1e-7) return start
  const fromWeight = Math.sin((1 - interpolationAmount) * theta) / sineTheta
  const toWeight = Math.sin(interpolationAmount * theta) / sineTheta
  return normalizeQuaternion([
    start[0] * fromWeight + end[0] * toWeight,
    start[1] * fromWeight + end[1] * toWeight,
    start[2] * fromWeight + end[2] * toWeight,
    start[3] * fromWeight + end[3] * toWeight,
  ])
}

/** Builds a unit quaternion for one normalized axis rotation. */
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

/** Applies device movement relative to the sensor pose captured at entry. */
export function relativeDeviceViewQuaternion(
  initialView: Quaternion,
  initialDevice: Quaternion,
  currentDevice: Quaternion,
): Quaternion {
  const worldDelta = multiplyQuaternions(currentDevice, invertQuaternion(initialDevice))
  return normalizeQuaternion(multiplyQuaternions(worldDelta, initialView))
}

/** Column-major rotation matrix accepted directly by WebGL uniformMatrix3fv. */
export function quaternionToMatrix3(quaternion: Quaternion): Float32Array {
  const [x, y, z, w] = normalizeQuaternion(quaternion)
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
