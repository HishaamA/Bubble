import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeopleTimelinePhoto } from './types'

type CapturedHumanConfig = {
  backend: string
  cacheSensitivity?: number
  skipAllowed?: boolean
  filter?: {
    equalization?: boolean
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
  detectedSources: [] as string[],
  failWebglInit: false,
  webglTensorDispose: vi.fn(),
  webglDetect: vi.fn(),
  cpuDetect: vi.fn(),
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
      if (this.backend === 'webgl' && humanMock.failWebglInit) {
        throw new Error('WebGL initialization failed')
      }
      humanMock.activeBackend = this.backend
    }

    async load() {
      humanMock.loadedBackends.push(this.backend)
    }

    async detect(input: LoadedImage) {
      humanMock.detectedSources.push(input.src)
      if (humanMock.activeBackend === 'webgl') {
        this.process.tensor = { dispose: humanMock.webglTensorDispose }
        return humanMock.webglDetect()
      }
      return humanMock.cpuDetect()
    }
  },
}))

class LoadedImage {
  crossOrigin = ''
  decoding = ''
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  #src = ''

  get src() {
    return this.#src
  }

  set src(value: string) {
    this.#src = value
    if (value) queueMicrotask(() => this.onload?.())
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
    humanMock.detectedSources.length = 0
    humanMock.failWebglInit = false
    humanMock.webglTensorDispose.mockReset()
    humanMock.webglDetect.mockReset()
    humanMock.cpuDetect.mockReset()
    vi.stubGlobal('Image', LoadedImage)
  })

  it('retries detection on CPU when WebGL inference fails', async () => {
    humanMock.webglDetect.mockRejectedValue(new Error('WebGL context lost'))
    humanMock.cpuDetect.mockResolvedValue({
      face: [{ embedding: [0.9, 0.1] }],
    })
    const { scanTimelineFaces } = await import('./faceRecognition')

    const result = await scanTimelineFaces([photo])

    expect(humanMock.backends).toEqual(['webgl', 'cpu'])
    expect(humanMock.initializedBackends).toEqual(['webgl', 'cpu'])
    expect(humanMock.loadedBackends).toEqual(['webgl', 'cpu'])
    expect(humanMock.disposedBackends).toEqual(['webgl'])
    expect(humanMock.resetBackends).toEqual(['webgl'])
    expect(humanMock.webglTensorDispose).toHaveBeenCalledTimes(1)
    expect(result.faceScans).toEqual({
      'photo:portrait': {
        scannedAt: expect.any(String),
        faces: [{
          id: 'face-1',
          embedding: [0.9, 0.1],
          box: [0, 0, 1, 1],
          detectorScore: 1,
          descriptorScore: 1,
          quality: 1,
        }],
      },
    })
    expect(result.failedPhotoCount).toBe(0)
    expect(humanMock.detectedSources).toEqual([
      '/portrait-full.jpg',
      '/portrait-full.jpg',
    ])
  })

  it('disposes a partially initialized WebGL runtime before loading CPU', async () => {
    humanMock.failWebglInit = true
    humanMock.cpuDetect.mockResolvedValue({
      face: [{ embedding: [0.8, 0.2] }],
    })
    const { scanTimelineFaces } = await import('./faceRecognition')

    const result = await scanTimelineFaces([photo])

    expect(humanMock.initializedBackends).toEqual(['webgl', 'cpu'])
    expect(humanMock.loadedBackends).toEqual(['cpu'])
    expect(humanMock.disposedBackends).toEqual(['webgl'])
    expect(result.faceScans['photo:portrait']?.faces[0]?.embedding).toEqual([
      0.8,
      0.2,
    ])
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
        embedding: [0.75, 0.25],
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
      embedding: [0.75, 0.25],
      box: [0.1, 0.1, 0.2, 0.2],
      detectorScore: 0.8,
      descriptorScore: 0.6,
      quality: 0.7262500000000001,
    }])
  })

  it('enrolls exactly one sufficiently clear face and returns its template quality', async () => {
    humanMock.webglDetect.mockResolvedValue({
      width: 1000,
      height: 1000,
      face: [{
        embedding: [0.75, 0.25],
        box: [100, 100, 200, 200],
        boxScore: 0.9,
        faceScore: 0.8,
      }],
    })
    const { scanReferencePortrait } = await import('./faceRecognition')

    await expect(scanReferencePortrait('/enrollment.jpg')).resolves.toEqual({
      embedding: [0.75, 0.25],
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
          embedding: [0.7, 0.3],
          box: [100, 100, 64, 64],
          boxScore: 1,
          faceScore: 1,
        }],
      })
      .mockResolvedValueOnce({
        width: 1000,
        height: 1000,
        face: [{
          embedding: [0.7, 0.3],
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
          { embedding: [1, 0] },
          { embedding: [0, 1] },
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
        { embedding: [0.9, 0.1] },
        { embedding: undefined },
      ],
    }
    humanMock.webglDetect.mockResolvedValue(partialResult)
    humanMock.cpuDetect
      .mockResolvedValueOnce(partialResult)
      .mockResolvedValueOnce({ face: [{ embedding: [0.9, 0.1] }] })
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
    expect(retried.faceScans['photo:portrait']?.faces[0]?.embedding).toEqual([
      0.9,
      0.1,
    ])
    expect(humanMock.detectedSources).toEqual([
      '/portrait-full.jpg',
      '/portrait-full.jpg',
      '/portrait-full.jpg',
    ])
  })
})
