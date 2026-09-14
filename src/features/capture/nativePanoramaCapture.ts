import { Capacitor, registerPlugin } from '@capacitor/core'

export type NativePanoramaCaptureOptions = {
  ownerKey?: string
  outputWidth?: number
  mode?: 'quick' | 'standard' | 'detailed'
}

export type NativePanoramaFrame = {
  id?: string
  uri?: string
  fileUrl?: string
  path?: string
  width: number
  height: number
  timestamp?: number
  timestampSeconds?: number
  yaw?: number
  pitch?: number
  roll?: number
  yawDegrees?: number
  pitchDegrees?: number
  rollDegrees?: number
  targetYaw?: number
  targetPitch?: number
  targetYawDegrees?: number
  targetPitchDegrees?: number
  horizontalFovDegrees?: number
  verticalFovDegrees?: number
  rotationDegrees?: number
  imageOrientation?: string
  poseSource?: string
  coordinateFrameId?: string
  intrinsics?: number[]
  transform?: number[]
  sharpnessScore?: number
}

export type NativePanoramaCaptureResult = {
  ownerKey?: string
  sessionId?: string
  createdAt?: string | number
  state?: string
  frames: NativePanoramaFrame[]
  targetCount: number
  initialTargetCount?: number
  coverageComplete?: boolean
  observedCoverage?: number
  capturedCount: number
  directoryUrl?: string
}

type PanoramaCapturePlugin = {
  startCapture(
    options?: NativePanoramaCaptureOptions,
  ): Promise<NativePanoramaCaptureResult>
  discardCapture(options: { directoryUrl: string; ownerKey?: string }): Promise<void>
}

type PanoramaCaptureRegistry = typeof globalThis & {
  __kinspherePanoramaCapture?: PanoramaCapturePlugin
}

const pluginRegistry = globalThis as PanoramaCaptureRegistry
const PanoramaCapture = pluginRegistry.__kinspherePanoramaCapture ??=
  registerPlugin<PanoramaCapturePlugin>('PanoramaCapture')

/** Reports whether the installed native shell exposes guided panorama capture. */
export function isNativePanoramaCaptureAvailable() {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable('PanoramaCapture')
  )
}

/** Starts native capture with production-safe defaults that callers may refine. */
export function startNativePanoramaCapture(
  options: NativePanoramaCaptureOptions = {},
) {
  return PanoramaCapture.startCapture({
    mode: 'standard',
    outputWidth: 2048,
    ...options,
  })
}

/** Removes originals only after an explicit, confirmed user action. */
export function discardNativePanoramaCapture(result: NativePanoramaCaptureResult) {
  if (!result.directoryUrl) return Promise.resolve()
  return PanoramaCapture.discardCapture({ directoryUrl: result.directoryUrl, ownerKey: result.ownerKey })
}

/** Converts a native frame URI into a WebView-safe image source. */
export function nativeFrameSource(frame: NativePanoramaFrame) {
  const source = frame.uri ?? frame.fileUrl ?? frame.path
  if (!source) {
    throw new Error('A captured frame is missing its local file URL.')
  }
  return Capacitor.convertFileSrc(source)
}

/** Distinguishes an intentional native dismissal from an actual capture error. */
export function isNativeCaptureCancellation(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; message?: unknown }
  return (
    candidate.code === 'CAPTURE_CANCELLED' ||
    (typeof candidate.message === 'string' &&
      /capture.cancelled|cancelled.capture/i.test(candidate.message))
  )
}
