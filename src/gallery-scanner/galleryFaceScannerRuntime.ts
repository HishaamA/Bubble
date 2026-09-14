import type { Human, Result } from '@vladmandic/human'
import {
  FacePhotoPipelineError,
  TFJS_WASM_VERSION,
  createFaceHumanConfig,
  extractFaceDetections,
  faceInferenceSize,
  isLikelyFaceBackendFailure,
  type FacePipelineBackend,
} from '../features/journal/people/faceRecognitionPipeline'
import type { StoredPhotoFaceScan } from '../features/journal/people/types'

type GalleryHumanRuntime = {
  backend: Extract<FacePipelineBackend, 'wasm' | 'cpu'>
  human: Human
}

let runtimePromise: Promise<GalleryHumanRuntime> | null = null
let poisonedRuntime: GalleryFaceRuntimeError | null = null
const PHOTO_DECODE_TIMEOUT_MS = 45_000

export class GalleryFaceRuntimeError extends Error {
  constructor(message = 'The on-device face scanner is unavailable') {
    super(message)
    this.name = 'GalleryFaceRuntimeError'
  }
}

function disposeHuman(human: Human) {
  const disposedModels = new Set<object>()
  for (const model of Object.values(human.models.models)) {
    if (!model || disposedModels.has(model)) continue
    disposedModels.add(model)
    try {
      model.dispose()
    } catch {
      // Continue releasing the remaining local model resources.
    }
  }
  human.models.reset()
  if (human.process.tensor) {
    try {
      human.process.tensor.dispose()
    } catch {
      // Failed inference can already have disposed this tensor.
    }
    human.process.tensor = null
  }
  human.process.canvas = null
}

/** Releases per-photo pixels/tensors while keeping the expensive models warm. */
function releaseProcessedPhoto(human: Human) {
  if (human.process.tensor) {
    try {
      human.process.tensor.dispose()
    } catch {
      // Human may already have released its inference input.
    }
    human.process.tensor = null
  }
  human.process.canvas = null
}

async function loadHuman(
  backend: GalleryHumanRuntime['backend'],
): Promise<GalleryHumanRuntime> {
  const { Human: HumanConstructor } = await import('@vladmandic/human')
  const human = new HumanConstructor(createFaceHumanConfig(backend))
  let initialized = false
  try {
    await human.init()
    initialized = true
    if (human.tf.getBackend() !== backend) {
      throw new GalleryFaceRuntimeError()
    }
    if (
      backend === 'wasm' &&
      human.tf.version?.['tfjs-backend-wasm'] !== TFJS_WASM_VERSION
    ) {
      throw new GalleryFaceRuntimeError(
        'The packaged TensorFlow WASM runtime does not match Bubble',
      )
    }
    await human.load()
    return { backend, human }
  } catch (error) {
    disposeHuman(human)
    if (initialized) throw new GalleryFaceRuntimeError()
    throw error
  }
}

async function loadPreferredRuntime() {
  try {
    return await loadHuman('wasm')
  } catch (error) {
    if (error instanceof GalleryFaceRuntimeError) throw error
    try {
      return await loadHuman('cpu')
    } catch {
      throw new GalleryFaceRuntimeError()
    }
  }
}

function getRuntime() {
  if (poisonedRuntime) return Promise.reject(poisonedRuntime)
  if (!runtimePromise) {
    runtimePromise = loadPreferredRuntime().catch((error: unknown) => {
      runtimePromise = null
      if (error instanceof GalleryFaceRuntimeError) poisonedRuntime = error
      throw error
    })
  }
  return runtimePromise
}

function loadPhoto(nativeId: string) {
  return new Promise<{ image: HTMLImageElement; release: () => void }>(
    (resolve, reject) => {
      const image = new Image()
      let settled = false
      let released = false
      const timeout = window.setTimeout(() => {
        if (settled) return
        settled = true
        release()
        reject(new FacePhotoPipelineError('Phone photo decode timed out'))
      }, PHOTO_DECODE_TIMEOUT_MS)
      const release = () => {
        if (released) return
        released = true
        window.clearTimeout(timeout)
        image.onload = null
        image.onerror = null
        image.src = ''
      }
      image.decoding = 'async'
      image.onload = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        resolve({ image, release })
      }
      image.onerror = () => {
        if (settled) return
        settled = true
        release()
        reject(new FacePhotoPipelineError('Phone photo could not be decoded'))
      }
      image.src = new URL(
        `/photo/${encodeURIComponent(nativeId)}`,
        window.location.origin,
      ).href
    },
  )
}

async function detect(
  runtime: GalleryHumanRuntime,
  image: HTMLImageElement,
  inferenceSize: { width: number; height: number },
): Promise<Result> {
  try {
    const result = await runtime.human.detect(image, { filter: inferenceSize })
    if (
      result.error &&
      isLikelyFaceBackendFailure(new Error(result.error))
    ) {
      throw new GalleryFaceRuntimeError()
    }
    return result
  } catch (error) {
    if (error instanceof GalleryFaceRuntimeError) throw error
    if (isLikelyFaceBackendFailure(error)) throw new GalleryFaceRuntimeError()
    throw new FacePhotoPipelineError()
  }
}

/** Scans one native-served JPEG without storing a copy in WebView persistence. */
export async function scanGalleryPhoto(
  nativeId: string,
): Promise<StoredPhotoFaceScan> {
  const runtime = await getRuntime()
  const { image, release } = await loadPhoto(nativeId)
  try {
    const inferenceSize = faceInferenceSize(
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
    )
    let result: Result
    try {
      result = await detect(runtime, image, inferenceSize)
    } catch (error) {
      if (error instanceof GalleryFaceRuntimeError) poisonedRuntime = error
      throw error
    }

    const detection = extractFaceDetections(result, inferenceSize)
    return {
      scannedAt: new Date().toISOString(),
      faces: detection.faces.map(({
        minPixelSize: _minPixelSize,
        maximumPoseAngle: _maximumPoseAngle,
        ...face
      }) => face),
    }
  } finally {
    releaseProcessedPhoto(runtime.human)
    release()
  }
}
