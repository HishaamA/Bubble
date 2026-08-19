import type { CapsuleImageSource } from '../../capsules/types'
import { processCapsuleImage } from '../../capsules/processCapsuleImage'
import type {
  PeopleTimelinePhoto,
  StoredFaceDetection,
  StoredPhotoFaceScan,
} from './types'

type HumanInstance = import('@vladmandic/human').Human

type HumanRuntime = {
  backend: 'webgl' | 'cpu'
  human: HumanInstance
}

export type FaceScanCheckpoint = {
  photoKey: string
  faceScan?: StoredPhotoFaceScan
  failed: boolean
  completed: number
  total: number
}

export type FaceScanResult = {
  faceScans: Record<string, StoredPhotoFaceScan>
  failedPhotoCount: number
  completedPhotoCount: number
}

export type ReferencePortraitScan = {
  embedding: number[]
  quality: number
}

export class ReferencePortraitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReferencePortraitError'
  }
}

let humanPromise: Promise<HumanRuntime> | null = null

class FaceDetectionFailure extends Error {
  constructor(message = 'Face detection failed') {
    super(message)
    this.name = 'FaceDetectionFailure'
  }
}

type ExtractedFaceDetection = StoredFaceDetection & {
  minPixelSize: number
  maximumPoseAngle: number
}

const TIMELINE_INFERENCE_WIDTH = 1280
const MIN_ENROLLMENT_FACE_SIZE = 96
const MIN_ENROLLMENT_DETECTOR_SCORE = 0.58
const MIN_ENROLLMENT_QUALITY = 0.62

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value))
}

function disposeHuman(human: HumanInstance) {
  const disposedModels = new Set<object>()
  for (const model of Object.values(human.models.models)) {
    if (!model || disposedModels.has(model)) continue
    disposedModels.add(model)
    try {
      model.dispose()
    } catch {
      // Continue releasing the remaining runtime resources.
    }
  }
  human.models.reset()

  const processedTensor = human.process.tensor
  if (processedTensor) {
    try {
      processedTensor.dispose()
    } catch {
      // A failed inference may already have released its input tensor.
    }
    human.process.tensor = null
  }
  human.process.canvas = null
}

async function loadHumanWithBackend(backend: 'webgl' | 'cpu') {
  const { Human } = await import('@vladmandic/human')
  const human = new Human({
    backend,
    debug: false,
    modelBasePath: '/models/human/',
    cacheModels: true,
    // Every call below is a different family photo, not another frame from a
    // video. Human's default temporal cache can otherwise reuse a preceding
    // photo's detector result and descriptor for several seconds.
    cacheSensitivity: 0,
    skipAllowed: false,
    filter: {
      enabled: true,
      equalization: true,
      width: TIMELINE_INFERENCE_WIDTH,
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
  })
  try {
    // Human's TensorFlow backend is process-global. `init` is required when a
    // second runtime changes it after the initial WebGL load.
    await human.init()
    if (human.tf.getBackend() !== backend) {
      throw new Error(`The ${backend} face backend could not be initialized`)
    }
    await human.load()
    return { backend, human } satisfies HumanRuntime
  } catch (error) {
    disposeHuman(human)
    throw error
  }
}

async function getHuman() {
  if (!humanPromise) {
    humanPromise = loadHumanWithBackend('webgl')
      .catch(() => loadHumanWithBackend('cpu'))
      .catch((error: unknown) => {
        humanPromise = null
        throw error
      })
  }
  return humanPromise
}

function switchToCpu(failedRuntime: HumanRuntime) {
  disposeHuman(failedRuntime.human)
  humanPromise = loadHumanWithBackend('cpu').catch((error: unknown) => {
    humanPromise = null
    throw error
  })
  return humanPromise
}

function loadImage(source: CapsuleImageSource) {
  return new Promise<{ image: HTMLImageElement; release: () => void }>(
    (resolve, reject) => {
      const image = new Image()
      const objectUrl = typeof source === 'string'
        ? null
        : URL.createObjectURL(source)
      const sourceUrl = objectUrl ?? source
      if (typeof sourceUrl !== 'string' || !sourceUrl) {
        reject(new Error('Photo source unavailable'))
        return
      }
      if (/^https?:/i.test(sourceUrl)) image.crossOrigin = 'anonymous'
      image.decoding = 'async'
      image.onload = () => resolve({
        image,
        release: () => {
          image.src = ''
          if (objectUrl) URL.revokeObjectURL(objectUrl)
        },
      })
      image.onerror = () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        reject(new Error('Photo could not be opened for an on-device scan'))
      }
      image.src = sourceUrl
    },
  )
}

function facePoseAngle(face: Awaited<ReturnType<HumanInstance['detect']>>['face'][number]) {
  const angle = face.rotation?.angle
  if (!angle) return 0
  return Math.max(
    Math.abs(angle.pitch ?? 0),
    Math.abs(angle.yaw ?? 0),
    Math.abs(angle.roll ?? 0),
  )
}

function normalizedFaceBox(
  box: readonly number[] | undefined,
  imageWidth: number,
  imageHeight: number,
): [number, number, number, number] {
  if (!box || box.length < 4 || imageWidth <= 0 || imageHeight <= 0) {
    return [0, 0, 1, 1]
  }
  const x = clampUnit((box[0] ?? 0) / imageWidth)
  const y = clampUnit((box[1] ?? 0) / imageHeight)
  const width = clampUnit((box[2] ?? 0) / imageWidth)
  const height = clampUnit((box[3] ?? 0) / imageHeight)
  return [x, y, Math.min(width, 1 - x), Math.min(height, 1 - y)]
}

function detectionQuality(
  detectorScore: number,
  descriptorScore: number,
  minPixelSize: number,
  maximumPoseAngle: number,
) {
  const sizeScore = clampUnit(minPixelSize / 160)
  const poseScore = clampUnit(1 - (maximumPoseAngle / 0.95))
  return clampUnit(
    detectorScore * 0.4 + descriptorScore * 0.25 + sizeScore * 0.25 + poseScore * 0.1,
  )
}

async function facesForPhoto(
  human: HumanInstance,
  source: CapsuleImageSource,
) {
  const { image, release } = await loadImage(source)
  try {
    let result
    try {
      result = await human.detect(image)
    } catch {
      throw new FaceDetectionFailure()
    }
    if (result.error) throw new FaceDetectionFailure(result.error)
    const imageWidth = result.width || image.naturalWidth || image.width || TIMELINE_INFERENCE_WIDTH
    const imageHeight = result.height || image.naturalHeight || image.height || TIMELINE_INFERENCE_WIDTH
    const extractedFaces: ExtractedFaceDetection[] = []
    for (const face of result.face) {
      const embedding = face.embedding
      if (!embedding?.length || !embedding.every(Number.isFinite)) {
        // A partial descriptor result is not a successful no-face scan. Keep
        // the photo pending so a later WebGL/session retry can recover it.
        throw new FaceDetectionFailure('Face descriptor extraction was incomplete')
      }
      const detectorScore = clampUnit(face.boxScore ?? face.faceScore ?? 1)
      const descriptorScore = clampUnit(face.faceScore ?? face.boxScore ?? 1)
      const minPixelSize = face.box?.length >= 4
        ? Math.max(0, Math.min(face.box[2] ?? 0, face.box[3] ?? 0))
        : 224
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
        maximumPoseAngle,
      })
    }
    extractedFaces.sort((left, right) =>
      left.box[1] - right.box[1] || left.box[0] - right.box[0],
    )
    extractedFaces.forEach((face, index) => {
      face.id = `face-${index + 1}`
    })
    return {
      detectedFaceCount: result.face.length,
      faces: extractedFaces,
    }
  } finally {
    release()
  }
}

export async function scanReferencePortrait(source: CapsuleImageSource) {
  let preparedSource = source
  if (typeof File !== 'undefined' && source instanceof File) {
    try {
      preparedSource = (await processCapsuleImage(source)).image
    } catch (error) {
      throw new ReferencePortraitError(
        error instanceof Error
          ? error.message
          : 'That photo could not be prepared safely on this device.',
      )
    }
  }

  let runtime: HumanRuntime
  try {
    runtime = await getHuman()
  } catch {
    throw new ReferencePortraitError(
      'Face recognition is unavailable on this device right now. Try again or add the person later.',
    )
  }

  let detection: Awaited<ReturnType<typeof facesForPhoto>>
  try {
    detection = await facesForPhoto(runtime.human, preparedSource)
  } catch (error) {
    if (error instanceof FaceDetectionFailure && runtime.backend === 'webgl') {
      try {
        runtime = await switchToCpu(runtime)
        detection = await facesForPhoto(runtime.human, preparedSource)
      } catch {
        throw new ReferencePortraitError(
          'That photo could not be scanned on this device. Try another clear portrait.',
        )
      }
    } else {
      throw new ReferencePortraitError(
        'That photo could not be opened. Try a JPEG, PNG, or WebP portrait.',
      )
    }
  }

  if (detection.detectedFaceCount === 0) {
    throw new ReferencePortraitError(
      'No clear face was found. Choose a well-lit, front-facing portrait.',
    )
  }
  if (detection.detectedFaceCount > 1) {
    throw new ReferencePortraitError(
      'More than one face was found. Choose a photo containing only this person.',
    )
  }
  const face = detection.faces[0]
  if (!face) {
    throw new ReferencePortraitError(
      'No clear face was found. Choose a well-lit, front-facing portrait.',
    )
  }
  if (
    face.detectorScore < MIN_ENROLLMENT_DETECTOR_SCORE ||
    face.minPixelSize < MIN_ENROLLMENT_FACE_SIZE ||
    face.maximumPoseAngle > 0.8 ||
    face.quality < MIN_ENROLLMENT_QUALITY
  ) {
    throw new ReferencePortraitError(
      'That face is too small, dark, or turned away. Choose a closer, well-lit photo.',
    )
  }
  return {
    embedding: [...face.embedding],
    quality: face.quality,
  } satisfies ReferencePortraitScan
}

export async function scanTimelineFaces(
  photos: readonly PeopleTimelinePhoto[],
  onCheckpoint?: (checkpoint: FaceScanCheckpoint) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<FaceScanResult> {
  const eligiblePhotos = photos.filter(({ canScanFaces }) => canScanFaces)
  if (!eligiblePhotos.length) {
    return { faceScans: {}, failedPhotoCount: 0, completedPhotoCount: 0 }
  }
  let runtime = await getHuman()
  const faceScans: Record<string, StoredPhotoFaceScan> = {}
  let failedPhotoCount = 0
  let completedPhotoCount = 0

  for (let index = 0; index < eligiblePhotos.length; index += 1) {
    if (signal?.aborted) break
    const photo = eligiblePhotos[index]
    if (!photo) continue
    let photoScan: StoredPhotoFaceScan | undefined
    try {
      const detection = await facesForPhoto(runtime.human, photo.scanSource)
      photoScan = {
        scannedAt: new Date().toISOString(),
        faces: detection.faces.map(({
          minPixelSize: _minPixelSize,
          maximumPoseAngle: _maximumPoseAngle,
          ...face
        }) => face),
      }
    } catch (error) {
      if (error instanceof FaceDetectionFailure && runtime.backend === 'webgl') {
        try {
          runtime = await switchToCpu(runtime)
          if (signal?.aborted) break
          const detection = await facesForPhoto(runtime.human, photo.scanSource)
          photoScan = {
            scannedAt: new Date().toISOString(),
            faces: detection.faces.map(({
              minPixelSize: _minPixelSize,
              maximumPoseAngle: _maximumPoseAngle,
              ...face
            }) => face),
          }
        } catch {
          photoScan = undefined
        }
      }
    }
    if (signal?.aborted) break
    if (photoScan) {
      faceScans[photo.key] = photoScan
    } else {
      failedPhotoCount += 1
    }
    completedPhotoCount += 1
    await onCheckpoint?.({
      photoKey: photo.key,
      faceScan: photoScan,
      failed: !photoScan,
      completed: completedPhotoCount,
      total: eligiblePhotos.length,
    })
    // Give the mobile WebView an opportunity to paint progress and release
    // transient tensors between independent photos.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  }

  return { faceScans, failedPhotoCount, completedPhotoCount }
}
