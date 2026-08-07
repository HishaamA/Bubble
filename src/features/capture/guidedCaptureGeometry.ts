export type GuideTarget = {
  id: string
  yaw: number
  pitch: number
}

export type GuideProjectionOptions = {
  horizontalFovDegrees?: number
  verticalFovDegrees?: number
}

type Vec3 = readonly [number, number, number]

function makeTargetRing(
  pitch: number,
  count: number,
  offset: number,
): GuideTarget[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${pitch}-${index}`,
    yaw: offset + index * (360 / count),
    pitch,
  }))
}

/**
 * The standard native capture pattern: one ceiling view, five staggered
 * room-height rings, and one floor view. Keep this distribution in sync with
 * the iOS and Android native capture controllers.
 */
export const STANDARD_GUIDE_TARGETS: readonly GuideTarget[] = [
  { id: 'zenith', yaw: 0, pitch: 82 },
  ...makeTargetRing(55, 5, 36),
  ...makeTargetRing(27, 7, 0),
  ...makeTargetRing(0, 8, 22.5),
  ...makeTargetRing(-27, 7, 360 / 14),
  ...makeTargetRing(-55, 5, 0),
  { id: 'nadir', yaw: 0, pitch: -82 },
]

const DEFAULT_HORIZONTAL_FOV_DEGREES = 62
const DEFAULT_VERTICAL_FOV_DEGREES = 78

function degreesToRadians(value: number) {
  return value * (Math.PI / 180)
}

function dot(left: Vec3, right: Vec3) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

function sphericalDirection(yawDegrees: number, pitchDegrees: number): Vec3 {
  const yaw = degreesToRadians(yawDegrees)
  const pitch = degreesToRadians(pitchDegrees)
  const cosPitch = Math.cos(pitch)
  return [
    Math.sin(yaw) * cosPitch,
    Math.sin(pitch),
    Math.cos(yaw) * cosPitch,
  ]
}

function cameraBasis(yawDegrees: number, pitchDegrees: number) {
  const yaw = degreesToRadians(yawDegrees)
  const pitch = degreesToRadians(pitchDegrees)
  const sinYaw = Math.sin(yaw)
  const cosYaw = Math.cos(yaw)
  const sinPitch = Math.sin(pitch)
  const cosPitch = Math.cos(pitch)

  return {
    forward: [cosPitch * sinYaw, sinPitch, cosPitch * cosYaw] as Vec3,
    right: [cosYaw, 0, -sinYaw] as Vec3,
    up: [-sinPitch * sinYaw, cosPitch, -sinPitch * cosYaw] as Vec3,
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

/**
 * Projects a spherical guide point through a rectilinear phone camera. Using
 * the actual camera frustum matters here: treating yaw and pitch like flat
 * screen axes makes an entire ring of capture dots appear in one view.
 */
export function projectGuideTarget(
  target: GuideTarget,
  view: { yaw: number; pitch: number },
  options: GuideProjectionOptions = {},
) {
  const horizontalFov = clamp(
    options.horizontalFovDegrees ?? DEFAULT_HORIZONTAL_FOV_DEGREES,
    20,
    150,
  )
  const verticalFov = clamp(
    options.verticalFovDegrees ?? DEFAULT_VERTICAL_FOV_DEGREES,
    20,
    150,
  )
  const basis = cameraBasis(view.yaw, view.pitch)
  const direction = sphericalDirection(target.yaw, target.pitch)
  const depth = dot(direction, basis.forward)
  const horizontalExtent = Math.tan(degreesToRadians(horizontalFov / 2))
  const verticalExtent = Math.tan(degreesToRadians(verticalFov / 2))
  const normalizedX = depth > 0
    ? dot(direction, basis.right) / (depth * horizontalExtent)
    : Number.POSITIVE_INFINITY
  const normalizedY = depth > 0
    ? dot(direction, basis.up) / (depth * verticalExtent)
    : Number.POSITIVE_INFINITY
  const visible =
    depth > 0 && Math.abs(normalizedX) < 1 && Math.abs(normalizedY) < 1
  const finiteX = Number.isFinite(normalizedX) ? clamp(normalizedX, -1.5, 1.5) : 0
  const finiteY = Number.isFinite(normalizedY) ? clamp(normalizedY, -1.5, 1.5) : 0
  const centreDistance = Math.hypot(finiteX, finiteY)

  return {
    visible,
    left: 50 + finiteX * 50,
    top: 50 - finiteY * 50,
    scale: Math.max(0.58, 1.2 - centreDistance * 0.5),
    centreDistance,
  }
}
