import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeopleTimelinePhoto } from './types'

type CapturedHumanConfig = {
  backend: string
  cacheSensitivity?: number
  skipAllowed?: boolean
  filter?: {
    equalization?: boolean
    width?: number
    height?: number
  }
  face?: {
    detector?: {
      rotation?: boolean
      skipFrames?: number
      skipTime?: number
    }
    description?: {
      skipFrames?: number
      skipTime?: number
    }
  }
}

const humanMock = vi.hoisted(() => ({
  backends: [] as string[],
  configs: [] as CapturedHumanConfig[],
  initializedBackends: [] as string[],
  loadedBackends: [] as string[],
  disposedBackends: [] as string[],
  resetBackends: [] as string[],
  activeBackend: '',
  loadedSources: [] as string[],
  detectedSources: [] as string[],
  failWebglInit: false,
  failWasmInit: false,
  failCpuInit: false,
  initWait: null as Promise<void> | null,
  detectConfigs: [] as Array<{ filter?: { width?: number; height?: number } } | undefined>,
  imageDimensions: new Map<string, [number, number]>(),
  stalledImages: new Set<string>(),
  images: [] as Array<{ src: string }>,
  galleryRead: vi.fn(),
  webglTensorDispose: vi.fn(),
  webglDetect: vi.fn(),
  wasmDetect: vi.fn(),
  cpuDetect: vi.fn(),
}))

vi.mock('../gallery/phoneGallery', () => ({
  isGalleryPhotoSource: (source: unknown) => typeof source === 'string' && source.startsWith('bubble-gallery:'),
  readGalleryPhotoSource: humanMock.galleryRead,
}))

vi.mock('@vladmandic/human', () => ({
  Human: class Human {
    backend: string
    process: { tensor: { dispose: () => void } | null; canvas: null } = {
      tensor: null,
      canvas: null,
    }
    models: {
      models: Record<string, { dispose: () => void } | null>
      reset: () => void
    }
    tf = {
      getBackend: () => humanMock.activeBackend,
      version: { 'tfjs-backend-wasm': '4.22.0' },
    }

    constructor(config: CapturedHumanConfig) {
      this.backend = config.backend
      humanMock.backends.push(config.backend)
      humanMock.configs.push(config)
      this.models = {
        models: {
          face: {
            dispose: () => humanMock.disposedBackends.push(this.backend),
          },
        },
        reset: () => humanMock.resetBackends.push(this.backend),
      }
    }

    async init() {
      humanMock.initializedBackends.push(this.backend)
      if (humanMock.initWait) await humanMock.initWait
      if (this.backend === 'webgl' && humanMock.failWebglInit) {
        throw new Error('WebGL initialization failed')
      }
      if (this.backend === 'wasm' && humanMock.failWasmInit) {
        throw new Error('WASM initialization failed')
      }
      if (this.backend === 'cpu' && humanMock.failCpuInit) throw new Error('CPU initialization failed')
      humanMock.activeBackend = this.backend
    }

    async load() {
      humanMock.loadedBackends.push(this.backend)
    }

    async detect(input: LoadedImage, config?: { filter?: { width?: number; height?: number } }) {
      humanMock.detectedSources.push(input.src)
      humanMock.detectConfigs.push(config)
      if (humanMock.activeBackend === 'webgl') {
        this.process.tensor = { dispose: humanMock.webglTensorDispose }
        return humanMock.webglDetect()
      }
      if (humanMock.activeBackend === 'wasm') return humanMock.wasmDetect()
      return humanMock.cpuDetect()
    }
  },
}))

class LoadedImage {
  naturalWidth = 1920
  naturalHeight = 1080
  width = 1920
  height = 1080
  crossOrigin = ''
  decoding = ''
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  #src = ''

  constructor() { humanMock.images.push(this) }

  get src() {
    return this.#src
  }

  set src(value: string) {
    this.#src = value
    if (value) {
      humanMock.loadedSources.push(value)
      const dimensions = humanMock.imageDimensions.get(value)
      if (dimensions) [this.naturalWidth, this.naturalHeight] = dimensions
      if (!humanMock.stalledImages.has(value)) queueMicrotask(() => this.onload?.())
    }
  }
}

const photo: PeopleTimelinePhoto = {
  key: 'photo:portrait',
  id: 'portrait',
  kind: 'capsule-photo',
  source: '/portrait-thumb.jpg',
  scanSource: '/portrait-full.jpg',
  capturedAt: '2025-01-01T12:00:00.000Z',
  caption: 'Portrait',
  contributorName: 'Maya',
  capsuleId: 'week',
  memoryId: 'capsule-week-portrait',
  canScanFaces: true,
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

/** Real FaceRes shape with distinct, finite, nonzero synthetic activations. */
function faceEmbedding(first: number, second: number) {
  return Array.from({ length: 1024 }, (_, index) => index % 2 === 0 ? first : second)
}

describe('on-device face recognition', () => {
  beforeEach(() => {
    vi.resetModules()
    humanMock.backends.length = 0
    humanMock.configs.length = 0
    humanMock.initializedBackends.length = 0
    humanMock.loadedBackends.length = 0
    humanMock.disposedBackends.length = 0
    humanMock.resetBackends.length = 0
    humanMock.activeBackend = ''
    humanMock.loadedSources.length = 0
    humanMock.detectedSources.length = 0
    humanMock.failWebglInit = false
    humanMock.failWasmInit = false
    humanMock.failCpuInit = false
    humanMock.initWait = null
    humanMock.detectConfigs.length = 0
    humanMock.imageDimensions.clear()
    humanMock.stalledImages.clear()
    humanMock.images.length = 0
    humanMock.galleryRead.mockReset()
    humanMock.webglTensorDispose.mockReset()
    humanMock.webglDetect.mockReset()
    humanMock.wasmDetect.mockReset()
    humanMock.cpuDetect.mockReset()
    vi.stubGlobal('Image', LoadedImage)
  })

  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('bounds each inference image by its long edge without upscaling', async () => {
    const { faceInferenceSize } = await import('./faceRecognition')
    expect(faceInferenceSize(160, 1600)).toEqual({ width: 128, height: 1280 })
    expect(faceInferenceSize(8000, 4000)).toEqual({ width: 1280, height: 640 })
    expect(faceInferenceSize(64, 32)).toEqual({ width: 64, height: 32 })
    expect(faceInferenceSize(1, 100_000)).toEqual({ width: 1, height: 1280 })
    expect(() => faceInferenceSize(0, 100)).toThrow()
    expect(() => faceInferenceSize(100, Number.NaN)).toThrow()
  })

  it('uses bounded tall-photo dimensions for Human and normalized result geometry', async () => {
    humanMock.imageDimensions.set(photo.scanSource as string, [160, 1600])
    humanMock.webglDetect.mockResolvedValue({ face: [{ embedding: faceEmbedding(1, 0), box: [32, 256, 64, 128] }] })
    const { scanTimelineFaces } = await import('./faceRecognition')
    const result = await scanTimelineFaces([photo])
    expect(humanMock.detectConfigs).toEqual([{ filter: { width: 128, height: 1280 } }])
    expect(result.faceScans[photo.key]?.faces[0]?.box).toEqual([0.25, 0.2, 0.5, 0.1])
    expect(result.faceScans[photo.key]?.faces[0]?.minFacePixels).toBe(64)
  })

  it('does not upscale a small photo or normalize against an unrelated default width', async () => {
    humanMock.imageDimensions.set(photo.scanSource as string, [64, 32])
    humanMock.webglDetect.mockResolvedValue({ face: [{ embedding: faceEmbedding(1, 0), box: [8, 4, 16, 8] }] })
    const { scanTimelineFaces } = await import('./faceRecognition')
    const result = await scanTimelineFaces([photo])
    expect(humanMock.detectConfigs).toEqual([{ filter: { width: 64, height: 32 } }])
    expect(result.faceScans[photo.key]?.faces[0]?.box).toEqual([0.125, 0.125, 0.25, 0.25])
    expect(result.faceScans[photo.key]?.faces[0]?.minFacePixels).toBe(8)
  })

  it('stops on global model startup failure instead of retrying every photo', async () => {
    humanMock.failWebglInit = true
    humanMock.failWasmInit = true
    humanMock.failCpuInit = true
    const { scanTimelineFaces, FaceRuntimeUnavailable } = await import('./faceRecognition')
    const checkpoint = vi.fn()
    await expect(scanTimelineFaces(Array.from({ length: 4697 }, (_, index) => ({ ...photo, key: `photo:${index}` })), checkpoint))
      .rejects.toBeInstanceOf(FaceRuntimeUnavailable)
    expect(humanMock.initializedBackends).toEqual(['webgl', 'wasm', 'cpu'])
    expect(checkpoint).not.toHaveBeenCalled()
    expect(humanMock.loadedSources).toEqual([])
  })

  it('stops when all fallback backends fail without treating every remaining photo as corrupt', async () => {
    humanMock.webglDetect.mockRejectedValue(new Error('Context lost'))
    humanMock.failWasmInit = true
    humanMock.failCpuInit = true
    const { scanTimelineFaces, FaceRuntimeUnavailable } = await import('./faceRecognition')
    await expect(scanTimelineFaces([photo, { ...photo, key: 'second' }])).rejects.toBeInstanceOf(FaceRuntimeUnavailable)
    expect(humanMock.detectedSources).toHaveLength(1)
  })

  it('delivers completed checkpoints before a later fatal runtime failure', async () => {
    humanMock.webglDetect.mockResolvedValueOnce({ face: [] }).mockRejectedValueOnce(new Error('Context lost'))
    humanMock.failWasmInit = true
    humanMock.failCpuInit = true
    const { scanTimelineFaces, FaceRuntimeUnavailable } = await import('./faceRecognition')
    const checkpoint = vi.fn()
    await expect(scanTimelineFaces([photo, { ...photo, key: 'second' }], checkpoint)).rejects.toBeInstanceOf(FaceRuntimeUnavailable)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ photoKey: photo.key, failed: false, completed: 1 }))
  })

  it('bounds stalled HTML image decoding and continues with the next photo', async () => {
    vi.useFakeTimers()
    humanMock.stalledImages.add(photo.scanSource as string)
    humanMock.webglDetect.mockResolvedValue({ face: [] })
    const { scanTimelineFaces } = await import('./faceRecognition')
    const pass = scanTimelineFaces([photo, { ...photo, key: 'second', scanSource: '/second.jpg' }])
    await vi.waitFor(() => expect(humanMock.loadedSources).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(20_010)
    const result = await pass
    expect(result.failedPhotoCount).toBe(1)
    expect(result.completedPhotoCount).toBe(2)
    expect(humanMock.detectedSources).toEqual(['/second.jpg'])
    expect(humanMock.images.every((image) => image.src === '')).toBe(true)
  })

  it('reports a stalled native read once and ignores its late result', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    humanMock.galleryRead.mockReturnValue(pending.promise)
    const { scanTimelineFaces } = await import('./faceRecognition')
    const error = scanTimelineFaces([{ ...photo, scanSource: 'bubble-gallery:1?scope=test' }]).catch((failure: unknown) => failure)
    await vi.waitFor(() => expect(humanMock.galleryRead).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await error).toMatchObject({ name: 'FaceRuntimeUnavailable', requiresRestart: false })
    pending.resolve('data:image/jpeg;base64,AAAA')
    await vi.advanceTimersByTimeAsync(0)
    expect(humanMock.loadedSources).toEqual([])
    expect(humanMock.detectedSources).toEqual([])
  })

  it('cancels a pending native read promptly without starting image decoding', async () => {
    const pending = deferred<string>()
    humanMock.galleryRead.mockReturnValue(pending.promise)
    const controller = new AbortController()
    const { scanTimelineFaces } = await import('./faceRecognition')
    const pass = scanTimelineFaces([{ ...photo, scanSource: 'bubble-gallery:1?scope=test' }], undefined, controller.signal)
    await vi.waitFor(() => expect(humanMock.galleryRead).toHaveBeenCalledTimes(1))
    controller.abort()
    expect(await pass).toMatchObject({ completedPhotoCount: 0 })
    pending.resolve('data:image/jpeg;base64,AAAA')
    await Promise.resolve()
    expect(humanMock.loadedSources).toEqual([])
  })

  it('poisons a hung model session without disposing or reusing its active runtime', async () => {
    vi.useFakeTimers()
    const pending = deferred<{ face: never[] }>()
    humanMock.webglDetect.mockReturnValue(pending.promise)
    const { scanTimelineFaces, FaceRuntimeUnavailable } = await import('./faceRecognition')
    const error = scanTimelineFaces([photo]).catch((failure: unknown) => failure)
    await vi.waitFor(() => expect(humanMock.webglDetect).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(60_001)
    expect(await error).toMatchObject({ name: 'FaceRuntimeUnavailable', requiresRestart: true })
    await expect(scanTimelineFaces([photo])).rejects.toBeInstanceOf(FaceRuntimeUnavailable)
    expect(humanMock.webglDetect).toHaveBeenCalledTimes(1)
    expect(humanMock.disposedBackends).toEqual([])
    expect(humanMock.images[0]?.src).toBe(photo.scanSource)
    pending.resolve({ face: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(humanMock.images[0]?.src).toBe('')
    expect(humanMock.disposedBackends).toEqual([])
  })

  it('does not begin model loading after a timed-out initialization eventually returns', async () => {
    vi.useFakeTimers()
    const pending = deferred<void>()
    humanMock.initWait = pending.promise
    const { scanTimelineFaces } = await import('./faceRecognition')
    const error = scanTimelineFaces([photo]).catch((failure: unknown) => failure)
    await vi.waitFor(() => expect(humanMock.initializedBackends).toEqual(['webgl']))
    await vi.advanceTimersByTimeAsync(60_001)
    expect(await error).toMatchObject({ name: 'FaceRuntimeUnavailable', requiresRestart: true })
    expect(humanMock.disposedBackends).toEqual([])
    pending.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(humanMock.loadedBackends).toEqual([])
    expect(humanMock.detectedSources).toEqual([])
    expect(humanMock.backends).toEqual(['webgl'])
  })

  it('keeps model ownership after cancellation until detection actually settles', async () => {
    const pending = deferred<{ face: never[] }>()
    humanMock.webglDetect.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ face: [] })
    const { scanTimelineFaces } = await import('./faceRecognition')
    const controller = new AbortController()
    const first = scanTimelineFaces([photo], undefined, controller.signal)
    await vi.waitFor(() => expect(humanMock.webglDetect).toHaveBeenCalledTimes(1))
    controller.abort()
    expect(await first).toMatchObject({ completedPhotoCount: 0 })
    const second = scanTimelineFaces([{ ...photo, key: 'second', scanSource: '/second.jpg' }])
    await Promise.resolve()
    expect(humanMock.webglDetect).toHaveBeenCalledTimes(1)
    expect(humanMock.images[0]?.src).toBe(photo.scanSource)
    pending.resolve({ face: [] })
    expect(await second).toMatchObject({ completedPhotoCount: 1 })
    expect(humanMock.webglDetect).toHaveBeenCalledTimes(2)
  })

  it('does not load the face engine or image when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { scanTimelineFaces } = await import('./faceRecognition')

    await expect(
      scanTimelineFaces([photo], undefined, controller.signal),
    ).resolves.toEqual({
      faceScans: {},
      failedPhotoCount: 0,
      completedPhotoCount: 0,
    })
    expect(humanMock.backends).toEqual([])
    expect(humanMock.loadedSources).toEqual([])
    expect(humanMock.detectedSources).toEqual([])
  })

  it('serializes concurrent inference on the process-wide Human runtime', async () => {
    const firstDetection = deferred<{ face: never[] }>()
    humanMock.webglDetect
      .mockImplementationOnce(() => firstDetection.promise)
      .mockResolvedValueOnce({ face: [] })
    const { scanTimelineFaces } = await import('./faceRecognition')
    const secondPhoto = {
      ...photo,
      key: 'photo:second',
      id: 'second',
      scanSource: '/second-full.jpg',
    }

    const firstPass = scanTimelineFaces([photo])
    await vi.waitFor(() => expect(humanMock.webglDetect).toHaveBeenCalledTimes(1))
    const secondPass = scanTimelineFaces([secondPhoto])
    await Promise.resolve()

    expect(humanMock.webglDetect).toHaveBeenCalledTimes(1)
    firstDetection.resolve({ face: [] })
    await Promise.all([firstPass, secondPass])

    expect(humanMock.webglDetect).toHaveBeenCalledTimes(2)
    expect(humanMock.detectedSources).toEqual([
      '/portrait-full.jpg',
      '/second-full.jpg',
    ])
  })

  it('drops a cancelled queued pass before image decode or inference', async () => {
    const firstDetection = deferred<{ face: never[] }>()
    humanMock.webglDetect.mockImplementationOnce(() => firstDetection.promise)
    const { scanTimelineFaces } = await import('./faceRecognition')
    const controller = new AbortController()
    const queuedPhoto = {
      ...photo,
      key: 'photo:queued',
      id: 'queued',
      scanSource: '/queued-full.jpg',
    }

    const activePass = scanTimelineFaces([photo])
    await vi.waitFor(() => expect(humanMock.webglDetect).toHaveBeenCalledTimes(1))
    const cancelledPass = scanTimelineFaces(
      [queuedPhoto],
      undefined,
      controller.signal,
    )
    controller.abort()
    firstDetection.resolve({ face: [] })
    const [, cancelledResult] = await Promise.all([activePass, cancelledPass])

    expect(cancelledResult).toEqual({
      faceScans: {},
      failedPhotoCount: 0,
      completedPhotoCount: 0,
    })
    expect(humanMock.loadedSources).toEqual(['/portrait-full.jpg'])
    expect(humanMock.detectedSources).toEqual(['/portrait-full.jpg'])
    expect(humanMock.webglDetect).toHaveBeenCalledTimes(1)
  })

  it('does not hot-switch a loaded TensorFlow runtime after WebGL failure', async () => {
    humanMock.webglDetect.mockRejectedValue(new Error('WebGL context lost'))
    const { scanTimelineFaces, FaceRuntimeUnavailable } = await import('./faceRecognition')

    await expect(scanTimelineFaces([photo])).rejects.toMatchObject({
      name: 'FaceRuntimeUnavailable',
      requiresRestart: true,
    })
    await expect(scanTimelineFaces([photo])).rejects.toBeInstanceOf(FaceRuntimeUnavailable)
    expect(humanMock.backends).toEqual(['webgl'])
    expect(humanMock.wasmDetect).not.toHaveBeenCalled()
    expect(humanMock.cpuDetect).not.toHaveBeenCalled()
    expect(humanMock.disposedBackends).toEqual([])
  })

  it('uses CPU only when both accelerated backends fail before loading', async () => {
    humanMock.failWebglInit = true
    humanMock.failWasmInit = true
    humanMock.cpuDetect.mockResolvedValue({ face: [] })
    const { scanTimelineFaces } = await import('./faceRecognition')

    await expect(scanTimelineFaces([photo])).resolves.toMatchObject({
      failedPhotoCount: 0,
      completedPhotoCount: 1,
    })
    expect(humanMock.backends).toEqual(['webgl', 'wasm', 'cpu'])
    expect(humanMock.disposedBackends).toEqual(['webgl', 'wasm'])
  })

  it('does not hot-switch when Human returns a backend error instead of throwing it', async () => {
    humanMock.webglDetect.mockResolvedValue({
      error: 'WebGL backend context lost',
      face: [],
    })
    const { scanTimelineFaces } = await import('./faceRecognition')

    await expect(scanTimelineFaces([photo])).rejects.toMatchObject({
      name: 'FaceRuntimeUnavailable',
      requiresRestart: true,
    })
    expect(humanMock.backends).toEqual(['webgl'])
    expect(humanMock.wasmDetect).not.toHaveBeenCalled()
  })

  it('does not replace the shared backend for a photo-specific detect failure', async () => {
    humanMock.webglDetect
      .mockRejectedValueOnce(new Error('Photo pixels could not be processed'))
      .mockResolvedValueOnce({ face: [] })
    const checkpoint = vi.fn()
    const { scanTimelineFaces } = await import('./faceRecognition')

    const result = await scanTimelineFaces([
      photo,
      { ...photo, key: 'photo:next', scanSource: '/next.jpg' },
    ], checkpoint)

    expect(result).toMatchObject({ failedPhotoCount: 1, completedPhotoCount: 2 })
    expect(humanMock.backends).toEqual(['webgl'])
    expect(humanMock.wasmDetect).not.toHaveBeenCalled()
    expect(humanMock.cpuDetect).not.toHaveBeenCalled()
    expect(checkpoint).toHaveBeenNthCalledWith(1, expect.objectContaining({
      photoKey: photo.key,
      failed: true,
    }))
  })

  it('disposes a partially initialized WebGL runtime before loading WASM', async () => {
    humanMock.failWebglInit = true
    humanMock.wasmDetect.mockResolvedValue({
      face: [{ embedding: faceEmbedding(0.8, 0.2) }],
    })
    const { scanTimelineFaces } = await import('./faceRecognition')

    const result = await scanTimelineFaces([photo])

    expect(humanMock.initializedBackends).toEqual(['webgl', 'wasm'])
    expect(humanMock.loadedBackends).toEqual(['wasm'])
    expect(humanMock.disposedBackends).toEqual(['webgl'])
    expect(result.faceScans['photo:portrait']?.faces[0]?.embedding).toEqual(faceEmbedding(0.8, 0.2))
  })

  it('falls through a failed WASM initialization to CPU', async () => {
    humanMock.failWebglInit = true
    humanMock.failWasmInit = true
    humanMock.cpuDetect.mockResolvedValue({ face: [] })
    const { scanTimelineFaces } = await import('./faceRecognition')

    await expect(scanTimelineFaces([photo])).resolves.toMatchObject({
      failedPhotoCount: 0,
    })
    expect(humanMock.initializedBackends).toEqual(['webgl', 'wasm', 'cpu'])
    expect(humanMock.loadedBackends).toEqual(['cpu'])
  })

  it('disables temporal caching and configures independent-photo preprocessing', async () => {
    humanMock.webglDetect.mockResolvedValue({ face: [] })
    const { scanTimelineFaces } = await import('./faceRecognition')

    await scanTimelineFaces([photo])

    expect(humanMock.configs[0]).toMatchObject({
      backend: 'webgl',
      cacheSensitivity: 0,
      skipAllowed: false,
      filter: { equalization: true },
      face: {
        detector: {
          rotation: true,
          skipFrames: 0,
          skipTime: 0,
        },
        description: {
          skipFrames: 0,
          skipTime: 0,
        },
      },
    })
  })

  it('stores normalized boxes, detector scores, descriptor scores, and quality', async () => {
    humanMock.webglDetect.mockResolvedValue({
      width: 1000,
      height: 500,
      face: [{
        embedding: faceEmbedding(0.75, 0.25),
        box: [100, 50, 200, 100],
        boxScore: 0.8,
        faceScore: 0.6,
        rotation: { angle: { pitch: 0, yaw: 0, roll: 0 } },
      }],
    })
    const { scanTimelineFaces } = await import('./faceRecognition')

    const result = await scanTimelineFaces([photo])

    expect(result.faceScans['photo:portrait']?.faces).toEqual([{
      id: 'face-1',
      embedding: faceEmbedding(0.75, 0.25),
      box: [0.1, 0.1, 0.2, 0.2],
      detectorScore: 0.8,
      descriptorScore: 0.6,
      quality: 0.7262500000000001,
      minFacePixels: 100,
    }])
  })

  it('does not invent face pixels or enrollment quality when geometry is missing', async () => {
    humanMock.webglDetect.mockResolvedValue({ face: [{ embedding: faceEmbedding(0.8, 0.2) }] })
    const { scanTimelineFaces, scanReferencePortrait } = await import('./faceRecognition')
    const result = await scanTimelineFaces([photo])
    expect(result.faceScans[photo.key]?.faces[0]).toMatchObject({ minFacePixels: 0, quality: 0.75 })
    await expect(scanReferencePortrait('/no-geometry.jpg')).rejects.toThrow('too small, dark, or turned away')
  })

  it('bounds saved face pixels by actual inference dimensions', async () => {
    humanMock.webglDetect.mockResolvedValue({
      width: 1280, height: 720,
      face: [{ embedding: faceEmbedding(0.8, 0.2), box: [0, 0, 5000, 5000] }],
    })
    const { scanTimelineFaces } = await import('./faceRecognition')
    const result = await scanTimelineFaces([photo])
    expect(result.faceScans[photo.key]?.faces[0]?.minFacePixels).toBe(720)
  })

  it.each([
    { label: '64-component descriptor', embedding: Array<number>(64).fill(0.9) },
    { label: 'truncated descriptor', embedding: Array<number>(1023).fill(0.9) },
    { label: 'oversized descriptor', embedding: Array<number>(1025).fill(0.9) },
    { label: 'all-zero descriptor', embedding: Array<number>(1024).fill(0) },
    { label: 'sparse descriptor', embedding: Object.assign(Array<number>(1024), { 0: 1 }) },
    { label: 'non-finite descriptor', embedding: [...Array<number>(1023).fill(0.9), Number.NaN] },
  ])('keeps $label failed and retryable instead of saving a no-face result', async ({ embedding }) => {
    const invalid = { face: [{ embedding, box: [100, 100, 200, 200] }] }
    humanMock.webglDetect.mockResolvedValueOnce(invalid).mockResolvedValueOnce({
      face: [{ embedding: faceEmbedding(0.9, 0.1), box: [100, 100, 120, 160] }],
    })
    const { scanTimelineFaces } = await import('./faceRecognition')
    const checkpoint = vi.fn()
    const next = { ...photo, key: 'photo:next', scanSource: '/next.jpg' }
    const result = await scanTimelineFaces([photo, next], checkpoint)
    expect(result.failedPhotoCount).toBe(1)
    expect(result.completedPhotoCount).toBe(2)
    expect(result.faceScans).not.toHaveProperty(photo.key)
    expect(result.faceScans[next.key]?.faces[0]).toMatchObject({
      embedding: faceEmbedding(0.9, 0.1), minFacePixels: 120,
    })
    expect(checkpoint).toHaveBeenNthCalledWith(1, expect.objectContaining({
      photoKey: photo.key, failed: true, faceScan: undefined,
    }))
    expect(checkpoint).toHaveBeenNthCalledWith(2, expect.objectContaining({
      photoKey: next.key, failed: false,
    }))
    expect(humanMock.backends).toEqual(['webgl'])
    expect(humanMock.cpuDetect).not.toHaveBeenCalled()
  })

  it('retains a genuine no-face scan as completed without adding size metadata', async () => {
    humanMock.webglDetect.mockResolvedValue({ face: [] })
    const { scanTimelineFaces } = await import('./faceRecognition')
    const result = await scanTimelineFaces([photo])
    expect(result.failedPhotoCount).toBe(0)
    expect(result.faceScans[photo.key]).toEqual({ scannedAt: expect.any(String), faces: [] })
  })

  it('enrolls exactly one sufficiently clear face and returns its template quality', async () => {
    humanMock.webglDetect.mockResolvedValue({
      width: 1000,
      height: 1000,
      face: [{
        embedding: faceEmbedding(0.75, 0.25),
        box: [100, 100, 200, 200],
        boxScore: 0.9,
        faceScore: 0.8,
      }],
    })
    const { scanReferencePortrait } = await import('./faceRecognition')

    await expect(scanReferencePortrait('/enrollment.jpg')).resolves.toEqual({
      embedding: faceEmbedding(0.75, 0.25),
      quality: 0.91,
    })
    expect(humanMock.detectedSources).toEqual(['/enrollment.jpg'])
  })

  it('rejects tiny and low-confidence enrollment portraits', async () => {
    humanMock.webglDetect
      .mockResolvedValueOnce({
        width: 1000,
        height: 1000,
        face: [{
          embedding: faceEmbedding(0.7, 0.3),
          box: [100, 100, 64, 64],
          boxScore: 1,
          faceScore: 1,
        }],
      })
      .mockResolvedValueOnce({
        width: 1000,
        height: 1000,
        face: [{
          embedding: faceEmbedding(0.7, 0.3),
          box: [100, 100, 200, 200],
          boxScore: 0.4,
          faceScore: 0.9,
        }],
      })
    const { scanReferencePortrait } = await import('./faceRecognition')

    await expect(scanReferencePortrait('/tiny.jpg')).rejects.toThrow(
      'too small, dark, or turned away',
    )
    await expect(scanReferencePortrait('/low-confidence.jpg')).rejects.toThrow(
      'too small, dark, or turned away',
    )
  })

  it('rejects a portrait with no face or more than one detected face', async () => {
    humanMock.webglDetect
      .mockResolvedValueOnce({ face: [] })
      .mockResolvedValueOnce({
        face: [
          { embedding: faceEmbedding(1, 0) },
          { embedding: faceEmbedding(0, 1) },
        ],
      })
    const { scanReferencePortrait } = await import('./faceRecognition')

    await expect(scanReferencePortrait('/empty.jpg')).rejects.toThrow(
      'No clear face was found',
    )
    await expect(scanReferencePortrait('/group.jpg')).rejects.toThrow(
      'More than one face was found',
    )
  })

  it('leaves partial descriptor scans failed so the photo can be retried', async () => {
    const partialResult = {
      face: [
        { embedding: faceEmbedding(0.9, 0.1) },
        { embedding: undefined },
      ],
    }
    humanMock.webglDetect
      .mockResolvedValueOnce(partialResult)
      .mockResolvedValueOnce({ face: [{ embedding: faceEmbedding(0.9, 0.1) }] })
    const checkpoint = vi.fn()
    const { scanTimelineFaces } = await import('./faceRecognition')

    const failed = await scanTimelineFaces([photo], checkpoint)

    expect(failed.faceScans).toEqual({})
    expect(failed.failedPhotoCount).toBe(1)
    expect(checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({
      photoKey: 'photo:portrait',
      faceScan: undefined,
      failed: true,
    }))

    const retried = await scanTimelineFaces([photo])

    expect(retried.failedPhotoCount).toBe(0)
    expect(retried.faceScans['photo:portrait']?.faces[0]?.embedding).toEqual(faceEmbedding(0.9, 0.1))
    expect(humanMock.detectedSources).toEqual([
      '/portrait-full.jpg',
      '/portrait-full.jpg',
    ])
    expect(humanMock.backends).toEqual(['webgl'])
    expect(humanMock.cpuDetect).not.toHaveBeenCalled()
  })
})
