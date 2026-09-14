import type {
  BackendEnum,
  Config,
  FaceResult,
  Result,
} from '@vladmandic/human'
import type { StoredFaceDetection } from './types'

export type FacePipelineBackend = Extract<BackendEnum, 'webgl' | 'wasm' | 'cpu'>

export type FaceInferenceDimensions = {
  width: number
  height: number
}

export type ExtractedFaceDetection = StoredFaceDetection & {
  minPixelSize: number
  maximumPoseAngle: number
}

export type ExtractedFaces = {
  detectedFaceCount: number
  faces: ExtractedFaceDetection[]
}

export const FACE_INFERENCE_LONG_EDGE = 1280
export const FACE_NATIVE_DECODE_LONG_EDGE = 1600
export const FACE_RES_DESCRIPTOR_LENGTH = 1024
export const HUMAN_MODEL_BASE_PATH = '/models/human/'
export const TFJS_WASM_ASSET_PATH = '/vendor/tfjs-wasm/'
export const TFJS_WASM_VERSION = '4.22.0'

/** A decoded photo/model result that failed without proving the backend is bad. */
export class FacePhotoPipelineError extends Error {
  constructor(message = 'Photo face extraction failed') {
    super(message)
    this.name = 'FacePhotoPipelineError'
  }
}

/** One source of truth for enrollment, foreground scans, and Android service scans. */
export function createFaceHumanConfig(
  backend: FacePipelineBackend,
): Partial<Config> {
  return {
    backend,
    ...(backend === 'wasm' ? {
      wasmPath: TFJS_WASM_ASSET_PATH,
      wasmPlatformFetch: true,
    } : {}),
    debug: false,
    modelBasePath: HUMAN_MODEL_BASE_PATH,
    cacheModels: true,
    // Each call is an independent family photo. Temporal reuse would attach a
    // preceding photo's detector result or descriptor to the next photo.
    cacheSensitivity: 0,
    skipAllowed: false,
    filter: {
      enabled: true,
      equalization: true,
      width: 0,
      height: 0,
      return: false,
    },
    face: {
      enabled: true,
      detector: {
        enabled: true,
        modelPath: 'blazeface.json',
        rotation: true,
        return: false,
        maxDetected: 20,
        minConfidence: 0.28,
        minSize: 20,
        skipFrames: 0,
        skipTime: 0,
      },
      mesh: {
        enabled: true,
        modelPath: 'facemesh.json',
        keepInvalid: false,
      },
      description: {
        enabled: true,
        modelPath: 'faceres.json',
        minConfidence: 0.45,
        skipFrames: 0,
        skipTime: 0,
      },
      attention: { enabled: false },
      iris: { enabled: false },
      emotion: { enabled: false },
      antispoof: { enabled: false },
      liveness: { enabled: false },
      gear: { enabled: false },
    },
    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    segmentation: { enabled: false },
    gesture: { enabled: false },
  }
}

/** Keeps both inference axes bounded while preserving source aspect ratio. */
export function faceInferenceSize(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new FacePhotoPipelineError('Photo dimensions are unavailable')
  }
  const scale = Math.min(
    1,
    FACE_INFERENCE_LONG_EDGE / Math.max(width, height),
  )
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value))
}

function facePoseAngle(face: FaceResult) {
  const angle = face.rotation?.angle
  if (!angle) return 0
  return Math.max(
    Math.abs(angle.pitch ?? 0),
    Math.abs(angle.yaw ?? 0),
    Math.abs(angle.roll ?? 0),
  )
}

function normalizedFaceBox(
  faceBox: readonly number[] | undefined,
  imageWidth: number,
  imageHeight: number,
): [number, number, number, number] {
  if (
    !faceBox ||
    faceBox.length < 4 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return [0, 0, 1, 1]
  }
  const normalizedX = clampUnit((faceBox[0] ?? 0) / imageWidth)
  const normalizedY = clampUnit((faceBox[1] ?? 0) / imageHeight)
  const normalizedWidth = clampUnit((faceBox[2] ?? 0) / imageWidth)
  const normalizedHeight = clampUnit((faceBox[3] ?? 0) / imageHeight)
  return [
    normalizedX,
    normalizedY,
    Math.min(normalizedWidth, 1 - normalizedX),
    Math.min(normalizedHeight, 1 - normalizedY),
  ]
}

function detectionQuality(
  detectorScore: number,
  descriptorScore: number,
  minPixelSize: number,
  maximumPoseAngle: number,
) {
  const sizeScore = clampUnit(minPixelSize / 160)
  const poseScore = clampUnit(1 - maximumPoseAngle / 0.95)
  return clampUnit(
    detectorScore * 0.4 +
      descriptorScore * 0.25 +
      sizeScore * 0.25 +
      poseScore * 0.1,
  )
}

/**
 * Converts Human's FaceRes output into the existing persisted scan schema.
 * Invalid descriptors are photo failures, never evidence that the backend died.
 */
export function extractFaceDetections(
  result: Pick<Result, 'error' | 'face' | 'height' | 'width'>,
  fallbackDimensions: FaceInferenceDimensions,
): ExtractedFaces {
  if (result.error) throw new FacePhotoPipelineError(result.error)
  const imageWidth = result.width || fallbackDimensions.width
  const imageHeight = result.height || fallbackDimensions.height
  const extractedFaces: ExtractedFaceDetection[] = []

  for (const face of result.face) {
    const embedding = face.embedding
    if (
      embedding?.length !== FACE_RES_DESCRIPTOR_LENGTH ||
      !Array.from(embedding).every(Number.isFinite) ||
      !embedding.some((value) => value !== 0)
    ) {
      throw new FacePhotoPipelineError(
        'Face descriptor extraction was incomplete or invalid',
      )
    }

    const detectorScore = clampUnit(face.boxScore ?? face.faceScore ?? 1)
    const descriptorScore = clampUnit(face.faceScore ?? face.boxScore ?? 1)
    const minPixelSize =
      face.box?.length >= 4 && Array.from(face.box).every(Number.isFinite)
        ? Math.max(
            0,
            Math.min(
              face.box[2] ?? 0,
              face.box[3] ?? 0,
              imageWidth,
              imageHeight,
              FACE_INFERENCE_LONG_EDGE,
            ),
          )
        : 0
    const maximumPoseAngle = facePoseAngle(face)
    extractedFaces.push({
      id: '',
      embedding: [...embedding],
      box: normalizedFaceBox(face.box, imageWidth, imageHeight),
      detectorScore,
      descriptorScore,
      quality: detectionQuality(
        detectorScore,
        descriptorScore,
        minPixelSize,
        maximumPoseAngle,
      ),
      minPixelSize,
      minFacePixels: minPixelSize,
      maximumPoseAngle,
    })
  }

  extractedFaces.sort(
    (left, right) => left.box[1] - right.box[1] || left.box[0] - right.box[0],
  )
  extractedFaces.forEach((face, index) => {
    face.id = `face-${index + 1}`
  })
  return { detectedFaceCount: result.face.length, faces: extractedFaces }
}

/** Only genuine runtime/backend errors justify replacing a shared backend. */
export function isLikelyFaceBackendFailure(error: unknown) {
  if (!(error instanceof Error)) return false
  return /(?:backend|webgl|webassembly|wasm|context\s+lost|shader|texture|kernel|gpu|gl_|out of memory|tensor.*disposed)/i.test(
    `${error.name}: ${error.message}`,
  )
}
