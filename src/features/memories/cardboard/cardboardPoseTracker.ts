import {
  alignQuaternionHemisphere,
  multiplyQuaternions,
  normalizeQuaternion,
  quaternionAngularDistanceDegrees,
  quaternionViewPitchDegrees,
  relativeDeviceViewQuaternion,
  slerpQuaternions,
  viewQuaternion,
  type Quaternion,
} from './stereoPanoramaMath'

export type CardboardTrackingState = 'waiting' | 'active' | 'stale'

// Ignore brief WebView/GC stalls; a genuinely dead sensor still falls back to
// synchronized drag quickly enough for a person holding the headset.
const STALE_AFTER_MS = 1200
const DEAD_BAND_DEGREES = 0.08
const REST_TIME_CONSTANT_MS = 32
const FAST_TIME_CONSTANT_MS = 8
const REST_SPEED_DEGREES_PER_SECOND = 2
const FAST_SPEED_DEGREES_PER_SECOND = 25

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const position = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return position * position * (3 - 2 * position)
}

export function normalizeScreenOrientationAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0
  return ((Math.round(angle / 90) * 90) % 360 + 360) % 360
}

export function isFiniteQuaternion(value: Quaternion): boolean {
  return value.every(Number.isFinite)
}

/**
 * Tracks one relative headset pose for both eyes. Screen-rotation and sensor
 * recovery samples are rebased onto the currently displayed pose, preventing
 * the 90-degree jump Android otherwise produces while entering landscape.
 */
export class CardboardPoseTracker {
  private anchorDevice: Quaternion | null = null
  private anchorView: Quaternion
  private filteredPose: Quaternion
  private displayPose: Quaternion
  private lastRaw: Quaternion | null = null
  private screenAngle: number | null = null
  private lastSampleTime: number | null = null
  private lastReceiptTime: number | null = null
  private state: CardboardTrackingState = 'waiting'
  private rebasePending = false

  constructor(initialView: Quaternion) {
    const normalized = normalizeQuaternion(initialView)
    this.anchorView = normalized
    this.filteredPose = normalized
    this.displayPose = normalized
  }

  reset(initialView: Quaternion): void {
    const normalized = normalizeQuaternion(initialView)
    this.anchorDevice = null
    this.anchorView = normalized
    this.filteredPose = normalized
    this.displayPose = normalized
    this.lastRaw = null
    this.screenAngle = null
    this.lastSampleTime = null
    this.lastReceiptTime = null
    this.state = 'waiting'
    this.rebasePending = false
  }

  prepareForTracking(): void {
    this.anchorDevice = null
    this.anchorView = this.displayPose
    this.filteredPose = this.displayPose
    this.lastRaw = null
    this.screenAngle = null
    this.lastSampleTime = null
    this.lastReceiptTime = null
    this.state = 'waiting'
    this.rebasePending = false
  }

  stopTracking(): void {
    this.anchorDevice = null
    this.anchorView = this.displayPose
    this.filteredPose = this.displayPose
    this.lastRaw = null
    this.screenAngle = null
    this.lastSampleTime = null
    this.lastReceiptTime = null
    this.state = 'waiting'
    this.rebasePending = false
  }

  getPose(): Quaternion {
    return this.displayPose
  }

  getState(): CardboardTrackingState {
    return this.state
  }

  markScreenOrientationChanged(): void {
    this.rebasePending = true
  }

  markStale(): boolean {
    if (this.state !== 'active') return false
    this.state = 'stale'
    this.rebasePending = true
    return true
  }

  updateStaleness(receiptTime: number): boolean {
    if (
      this.state === 'active' &&
      this.lastReceiptTime !== null &&
      receiptTime - this.lastReceiptTime > STALE_AFTER_MS
    ) {
      return this.markStale()
    }
    return false
  }

  /** Allows synchronized drag while sensors are unavailable or have stalled. */
  applyManualDelta(yawDegrees: number, pitchDegrees: number): Quaternion {
    const yaw = viewQuaternion(yawDegrees, 0)
    const currentPitch = quaternionViewPitchDegrees(this.displayPose)
    const clampedPitch = clamp(currentPitch + pitchDegrees, -85, 85)
    const pitch = viewQuaternion(0, clampedPitch - currentPitch)
    this.displayPose = normalizeQuaternion(
      multiplyQuaternions(yaw, multiplyQuaternions(this.displayPose, pitch)),
    )
    this.filteredPose = this.displayPose
    this.anchorView = this.displayPose
    if (this.state === 'active') {
      this.state = 'stale'
      this.rebasePending = true
    }
    return this.displayPose
  }

  sample(
    devicePose: Quaternion,
    screenAngleDegrees: number,
    sampleTime: number,
    receiptTime: number,
  ): CardboardTrackingState | null {
    if (
      !isFiniteQuaternion(devicePose) ||
      !Number.isFinite(sampleTime) ||
      !Number.isFinite(receiptTime)
    ) {
      return null
    }

    const raw = normalizeQuaternion(devicePose)
    const angle = normalizeScreenOrientationAngle(screenAngleDegrees)
    const receiptGap = this.lastReceiptTime === null
      ? 0
      : receiptTime - this.lastReceiptTime
    const screenChanged = this.screenAngle !== null && angle !== this.screenAngle
    const requiresRebase =
      this.anchorDevice === null ||
      this.state === 'stale' ||
      this.rebasePending ||
      screenChanged ||
      receiptGap > STALE_AFTER_MS

    if (requiresRebase) {
      this.anchorDevice = raw
      this.anchorView = this.displayPose
      this.filteredPose = this.displayPose
      this.lastRaw = raw
      this.screenAngle = angle
      this.lastSampleTime = sampleTime
      this.lastReceiptTime = receiptTime
      this.rebasePending = false
      this.state = 'active'
      return this.state
    }

    const previousRaw = this.lastRaw ?? raw
    const alignedRaw = alignQuaternionHemisphere(previousRaw, raw)
    const sampleDelta = this.lastSampleTime === null
      ? 16.67
      : sampleTime - this.lastSampleTime
    const receiptDelta = this.lastReceiptTime === null
      ? 16.67
      : receiptTime - this.lastReceiptTime
    const usableDelta = sampleDelta > 0 && sampleDelta <= 250
      ? sampleDelta
      : receiptDelta > 0 && receiptDelta <= 250
        ? receiptDelta
        : 16.67
    const deltaMs = clamp(usableDelta, 1, 50)
    const rawDistance = quaternionAngularDistanceDegrees(previousRaw, alignedRaw)
    const speed = rawDistance / (deltaMs / 1000)

    // A very large instantaneous discontinuity is a sensor-frame reset. Keep
    // the current image still and establish a new frame instead of spinning.
    if (rawDistance > 45 && speed > 1200) {
      this.anchorDevice = alignedRaw
      this.anchorView = this.displayPose
      this.filteredPose = this.displayPose
      this.lastRaw = alignedRaw
      this.screenAngle = angle
      this.lastSampleTime = sampleTime
      this.lastReceiptTime = receiptTime
      return this.state
    }

    const anchorDevice = this.anchorDevice
    if (!anchorDevice) return null
    const target = alignQuaternionHemisphere(
      this.filteredPose,
      relativeDeviceViewQuaternion(
        this.anchorView,
        anchorDevice,
        alignedRaw,
      ),
    )
    const error = quaternionAngularDistanceDegrees(this.filteredPose, target)
    if (error > DEAD_BAND_DEGREES) {
      const motion = smoothstep(
        REST_SPEED_DEGREES_PER_SECOND,
        FAST_SPEED_DEGREES_PER_SECOND,
        speed,
      )
      const timeConstant =
        REST_TIME_CONSTANT_MS +
        (FAST_TIME_CONSTANT_MS - REST_TIME_CONSTANT_MS) * motion
      const response = 1 - Math.exp(-deltaMs / timeConstant)
      const deadBandWeight = (error - DEAD_BAND_DEGREES) / error
      this.filteredPose = slerpQuaternions(
        this.filteredPose,
        target,
        response * deadBandWeight,
      )
      this.displayPose = this.filteredPose
    }

    this.lastRaw = alignedRaw
    this.screenAngle = angle
    this.lastSampleTime = sampleTime
    this.lastReceiptTime = receiptTime
    this.state = 'active'
    return this.state
  }
}
