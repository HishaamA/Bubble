import type { CapsuleImageSource } from '../../capsules/types'
import { isGalleryPhotoSource, readGalleryPhotoSource } from '../gallery/phoneGallery'
import { processCapsuleImage } from '../../capsules/processCapsuleImage'
import {
  FACE_NATIVE_DECODE_LONG_EDGE,
  FacePhotoPipelineError,
  TFJS_WASM_VERSION,
  createFaceHumanConfig,
  extractFaceDetections,
  faceInferenceSize,
  isLikelyFaceBackendFailure,
  type FacePipelineBackend,
} from './faceRecognitionPipeline'
import type {
  PeopleTimelinePhoto,
  StoredPhotoFaceScan,
} from './types'

export { faceInferenceSize } from './faceRecognitionPipeline'

type HumanInstance = import('@vladmandic/human').Human

type HumanRuntime = {
  backend: FacePipelineBackend
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

/** User-correctable enrollment failure for a supplied reference portrait. */
export class ReferencePortraitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReferencePortraitError'
  }
}

let humanPromise: Promise<HumanRuntime> | null = null
let humanOperationTail: Promise<void> = Promise.resolve()
let poisonedRuntime: FaceRuntimeUnavailable | null = null
const runtimePoisonListeners = new Set<(error: FaceRuntimeUnavailable) => void>()
const HUMAN_OPERATION_TIMEOUT_MS = 60_000
const NATIVE_PHOTO_TIMEOUT_MS = 30_000
const IMAGE_LOAD_TIMEOUT_MS = 20_000

/** Internal cancellation marker kept distinct from a failed photo decode. */
class FaceScanAborted extends Error {
  constructor() {
    super('Face scan cancelled')
    this.name = 'FaceScanAborted'
  }
}

/** Distinguishes model startup failures from correctable portrait failures. */
export class FaceRuntimeUnavailable extends Error {
  readonly code = 'FACE_RUNTIME_UNAVAILABLE'
  readonly requiresRestart: boolean

  constructor(
    message = 'Face recognition could not start. Try scanning again.',
    requiresRestart = false,
  ) {
    super(message)
    this.name = 'FaceRuntimeUnavailable'
    this.requiresRestart = requiresRestart
  }
}

/** A proven backend failure that may safely advance to the next backend. */
class FaceBackendFailure extends Error {
  constructor(message = 'Face detection backend failed') {
    super(message)
    this.name = 'FaceBackendFailure'
  }
}

/** Stops work at the next safe boundary; an active Human detect cannot be interrupted. */
function throwIfFaceScanAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new FaceScanAborted()
}

function throwIfRuntimePoisoned() {
  if (poisonedRuntime) throw poisonedRuntime
}

function invalidateRuntime(message: string) {
  if (poisonedRuntime) return poisonedRuntime
  poisonedRuntime = new FaceRuntimeUnavailable(message, true)
  runtimePoisonListeners.forEach((notify) => notify(poisonedRuntime!))
  return poisonedRuntime
}

/** Do not dispose or reuse a TensorFlow runtime whose operation never settled. */
function poisonRuntime() {
  invalidateRuntime(
    'Face matching stopped responding. Close and reopen Bubble to safely restart it; previously saved progress is kept.',
  )
}

/** Cancellation stops the caller's wait, never the underlying model ownership. */
function waitForHumanResult<Result>(operation: Promise<Result>, signal?: AbortSignal) {
  return new Promise<Result>((resolve, reject) => {
    let settled = false
    const clean = () => {
      signal?.removeEventListener('abort', abort)
      runtimePoisonListeners.delete(failRuntime)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      clean()
      reject(error)
    }
    const abort = () => fail(new FaceScanAborted())
    const failRuntime = (error: FaceRuntimeUnavailable) => fail(error)
    operation.then((result) => {
      if (settled) return
      settled = true
      clean()
      resolve(result)
    }, fail)
    runtimePoisonListeners.add(failRuntime)
    signal?.addEventListener('abort', abort, { once: true })
    if (poisonedRuntime) fail(poisonedRuntime)
    else if (signal?.aborted) abort()
  })
}

/**
 * Serializes access to Human's process-global TensorFlow runtime. This keeps a
 * reference enrollment and an automatic library pass from running inference
 * concurrently or replacing the WebGL backend while another call is using it.
 */
async function withHumanOperation<Result>(
  signal: AbortSignal | undefined,
  operation: () => Promise<Result>,
) {
  throwIfFaceScanAborted(signal)
  throwIfRuntimePoisoned()
  const current = humanOperationTail.then(async () => {
    throwIfFaceScanAborted(signal)
    throwIfRuntimePoisoned()
    // This watchdog outlives a cancelled UI wait. A stuck operation continues
    // owning the queue and its image until it actually settles; poison rejects
    // current/future callers rather than starting concurrent model work.
    const watchdog = window.setTimeout(poisonRuntime, HUMAN_OPERATION_TIMEOUT_MS)
    try { return await operation() }
    finally { window.clearTimeout(watchdog) }
  })
  humanOperationTail = current.then(() => undefined, () => undefined)
  return waitForHumanResult(current, signal)
}

const MIN_ENROLLMENT_FACE_SIZE = 96
const MIN_ENROLLMENT_DETECTOR_SCORE = 0.58
const MIN_ENROLLMENT_QUALITY = 0.62

/** Releases model tensors and canvases before replacing an inference runtime. */
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

/** Configures and loads the minimal Human pipeline required for face matching. */
async function loadHumanWithBackend(backend: FacePipelineBackend) {
  throwIfRuntimePoisoned()
  const { Human } = await import('@vladmandic/human')
  throwIfRuntimePoisoned()
  const human = new Human(createFaceHumanConfig(backend))
  let initialized = false
  try {
    // Human's TensorFlow backend is process-global. `init` is required when a
    // second runtime changes it after the initial WebGL load.
    await human.init()
    initialized = true
    throwIfRuntimePoisoned()
    if (human.tf.getBackend() !== backend) {
      throw new Error(`The ${backend} face backend could not be initialized`)
    }
    if (
      backend === 'wasm' &&
      human.tf.version?.['tfjs-backend-wasm'] !== TFJS_WASM_VERSION
    ) {
      throw new Error('The packaged TensorFlow WASM runtime version is invalid')
    }
    await human.load()
    return { backend, human } satisfies HumanRuntime
  } catch (error) {
    disposeHuman(human)
    if (initialized) {
      throw invalidateRuntime(
        'Face recognition could not finish loading safely. Close and reopen Bubble, then try again.',
      )
    }
    throw error
  }
}

async function loadFirstAvailableBackend(
  backends: readonly FacePipelineBackend[],
): Promise<HumanRuntime> {
  let lastError: unknown
  for (const backend of backends) {
    try {
      return await loadHumanWithBackend(backend)
    } catch (error) {
      throwIfRuntimePoisoned()
      if (error instanceof FaceRuntimeUnavailable) throw error
      lastError = error
    }
  }
  throw lastError ?? new Error('No face backend is available')
}

/** Shares one lazy runtime and prefers SIMD-capable WASM before the slow CPU path. */
async function getHuman() {
  if (!humanPromise) {
    humanPromise = loadFirstAvailableBackend(['webgl', 'wasm', 'cpu'])
      .catch((error: unknown) => {
        humanPromise = null
        throw error
      })
  }
  return humanPromise
}

/** Bounds native bridge waits without retaining a cancelled image-load owner. */
function waitForNativePhoto(operation: Promise<string>, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown, result?: string) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = () => finish(new FaceScanAborted())
    const timeout = window.setTimeout(() => finish(new FaceRuntimeUnavailable(
      'A phone photo took too long to open. Retry scanning; if it remains stuck, close and reopen Bubble.',
    )), NATIVE_PHOTO_TIMEOUT_MS)
    operation.then((result) => finish(undefined, result), (error) => finish(error))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/** Loads URL or Blob media and returns an explicit resource-release callback. */
async function loadImage(source: CapsuleImageSource, signal?: AbortSignal) {
  if (signal?.aborted) throw new FaceScanAborted()
  if (isGalleryPhotoSource(source)) {
    source = await waitForNativePhoto(
      readGalleryPhotoSource(source, FACE_NATIVE_DECODE_LONG_EDGE),
      signal,
    )
  }
  if (signal?.aborted) throw new FaceScanAborted()
  return new Promise<{ image: HTMLImageElement; release: () => void }>(
    (resolve, reject) => {
      const image = new Image()
      const objectUrl = typeof source === 'string'
        ? null
        : URL.createObjectURL(source)
      const sourceUrl = objectUrl ?? source
      let settled = false
      let released = false
      let timeout: number | undefined
      const removeAbortListener = () => {
        signal?.removeEventListener('abort', abortLoad)
        if (timeout !== undefined) window.clearTimeout(timeout)
      }
      const release = () => {
        if (released) return
        released = true
        image.onload = null
        image.onerror = null
        image.src = ''
        if (objectUrl) URL.revokeObjectURL(objectUrl)
      }
      function abortLoad() {
        if (settled) return
        settled = true
        removeAbortListener()
        release()
        reject(new FaceScanAborted())
      }
      if (typeof sourceUrl !== 'string' || !sourceUrl) {
        settled = true
        release()
        reject(new Error('Photo source unavailable'))
        return
      }
      if (/^https?:/i.test(sourceUrl)) image.crossOrigin = 'anonymous'
      image.decoding = 'async'
      image.onload = () => {
        if (settled) return
        settled = true
        removeAbortListener()
        resolve({ image, release })
      }
      image.onerror = () => {
        if (settled) return
        settled = true
        removeAbortListener()
        release()
        reject(new Error('Photo could not be opened for an on-device scan'))
      }
      if (signal?.aborted) {
        abortLoad()
        return
      }
      signal?.addEventListener('abort', abortLoad, { once: true })
      timeout = window.setTimeout(() => {
        if (settled) return
        settled = true
        removeAbortListener()
        release()
        reject(new Error('Photo took too long to decode'))
      }, IMAGE_LOAD_TIMEOUT_MS)
      image.src = sourceUrl
    },
  )
}

/** Extracts deterministic, position-ordered descriptors from one independent photo. */
async function facesForPhoto(
  human: HumanInstance,
  source: CapsuleImageSource,
  signal?: AbortSignal,
) {
  throwIfFaceScanAborted(signal)
  const { image, release } = await loadImage(source, signal)
  try {
    throwIfFaceScanAborted(signal)
    throwIfRuntimePoisoned()
    const inferenceSize = faceInferenceSize(
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
    )
    let result
    try {
      // Human does not expose cancellation for a detect already in progress;
      // cancellation is observed immediately before and after that call.
      result = await human.detect(image, { filter: inferenceSize })
      if (
        result.error &&
        isLikelyFaceBackendFailure(new Error(result.error))
      ) {
        throw new FaceBackendFailure()
      }
    } catch (error) {
      throwIfFaceScanAborted(signal)
      if (error instanceof FaceBackendFailure) throw error
      if (isLikelyFaceBackendFailure(error)) throw new FaceBackendFailure()
      throw new FacePhotoPipelineError()
    }
    throwIfFaceScanAborted(signal)
    throwIfRuntimePoisoned()
    return extractFaceDetections(result, inferenceSize)
  } finally {
    release()
  }
}

/** Runs one image through the serialized runtime without unsafe hot switching. */
async function detectFaces(
  source: CapsuleImageSource,
  signal?: AbortSignal,
) {
  return withHumanOperation(signal, async () => {
    throwIfFaceScanAborted(signal)
    let runtime: HumanRuntime
    try {
      runtime = await getHuman()
    } catch (error) {
      if (error instanceof FaceRuntimeUnavailable) throw error
      throw new FaceRuntimeUnavailable()
    }
    throwIfFaceScanAborted(signal)
    throwIfRuntimePoisoned()

    try {
      return await facesForPhoto(runtime.human, source, signal)
    } catch (error) {
      if (error instanceof FaceBackendFailure) {
        throw invalidateRuntime(
          'The face backend stopped working. Close and reopen Bubble to safely restart it; saved progress is kept.',
        )
      }
      throw error
    }
  })
}

/** Extracts one high-quality face descriptor from a reference portrait. */
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

  let detection: Awaited<ReturnType<typeof facesForPhoto>>
  try {
    detection = await detectFaces(preparedSource)
  } catch (error) {
    if (error instanceof FaceRuntimeUnavailable) {
      throw new ReferencePortraitError(
        error.message,
      )
    }
    if (error instanceof FacePhotoPipelineError || error instanceof FaceBackendFailure) {
      throw new ReferencePortraitError(
        'That photo could not be scanned on this device. Try another clear portrait.',
      )
    }
    throw new ReferencePortraitError(
      'That photo could not be opened. Try a JPEG, PNG, or WebP portrait.',
    )
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

/** Scans eligible timeline photos once and reports incremental checkpoints. */
export async function scanTimelineFaces(
  photos: readonly PeopleTimelinePhoto[],
  onCheckpoint?: (checkpoint: FaceScanCheckpoint) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<FaceScanResult> {
  const eligiblePhotos = photos.filter(({ canScanFaces }) => canScanFaces)
  if (!eligiblePhotos.length || signal?.aborted) {
    return { faceScans: {}, failedPhotoCount: 0, completedPhotoCount: 0 }
  }
  const faceScans: Record<string, StoredPhotoFaceScan> = {}
  let failedPhotoCount = 0
  let completedPhotoCount = 0

  for (let index = 0; index < eligiblePhotos.length; index += 1) {
    if (signal?.aborted) break
    const photo = eligiblePhotos[index]
    if (!photo) continue
    let photoScan: StoredPhotoFaceScan | undefined
    try {
      const detection = await detectFaces(photo.scanSource, signal)
      photoScan = {
        scannedAt: new Date().toISOString(),
        faces: detection.faces.map(({
          minPixelSize: _minPixelSize,
          maximumPoseAngle: _maximumPoseAngle,
          ...face
        }) => face),
      }
    } catch (error) {
      if (error instanceof FaceScanAborted || signal?.aborted) break
      // Startup/poisoned/native-bridge failures affect the whole pass. Repeating
      // them for thousands of photos hides the actual blocker and burns time.
      if (error instanceof FaceRuntimeUnavailable) throw error
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
