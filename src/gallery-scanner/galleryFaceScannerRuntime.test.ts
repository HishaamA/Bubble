import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFaceHumanConfig } from '../features/journal/people/faceRecognitionPipeline'

type Config = ReturnType<typeof createFaceHumanConfig>

const runtimeMock = vi.hoisted(() => ({
  activeBackend: '',
  backends: [] as string[],
  configs: [] as Config[],
  sources: [] as string[],
  detectConfigs: [] as unknown[],
  disposed: [] as string[],
  failWasmInit: false,
  wasmDetect: vi.fn(),
  cpuDetect: vi.fn(),
}))

vi.mock('@vladmandic/human', () => ({
  Human: class Human {
    backend: string
    process: { tensor: null; canvas: null } = { tensor: null, canvas: null }
    models: {
      models: Record<string, { dispose: () => void }>
      reset: () => void
    }
    tf = {
      getBackend: () => runtimeMock.activeBackend,
      version: { 'tfjs-backend-wasm': '4.22.0' },
    }

    constructor(config: Config) {
      this.backend = String(config.backend)
      runtimeMock.backends.push(this.backend)
      runtimeMock.configs.push(config)
      this.models = {
        models: {
          face: { dispose: () => runtimeMock.disposed.push(this.backend) },
        },
        reset: vi.fn(),
      }
    }

    async init() {
      if (this.backend === 'wasm' && runtimeMock.failWasmInit) {
        throw new Error('WASM initialization failed')
      }
      runtimeMock.activeBackend = this.backend
    }

    async load() {}

    async detect(_image: HTMLImageElement, config: unknown) {
      runtimeMock.detectConfigs.push(config)
      return this.backend === 'wasm'
        ? runtimeMock.wasmDetect()
        : runtimeMock.cpuDetect()
    }
  },
}))

class NativePhotoImage {
  naturalWidth = 1600
  naturalHeight = 900
  width = 1600
  height = 900
  decoding = ''
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  #src = ''

  get src() {
    return this.#src
  }

  set src(value: string) {
    this.#src = value
    runtimeMock.sources.push(value)
    if (value) queueMicrotask(() => this.onload?.())
  }
}

function embedding() {
  return Array<number>(1024).fill(0.5)
}

describe('gallery scanner Human runtime', () => {
  beforeEach(() => {
    vi.resetModules()
    runtimeMock.activeBackend = ''
    runtimeMock.backends.length = 0
    runtimeMock.configs.length = 0
    runtimeMock.sources.length = 0
    runtimeMock.detectConfigs.length = 0
    runtimeMock.disposed.length = 0
    runtimeMock.failWasmInit = false
    runtimeMock.wasmDetect.mockReset()
    runtimeMock.cpuDetect.mockReset()
    vi.stubGlobal('Image', NativePhotoImage)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('uses local WASM and the same 1600-to-1280 face pipeline on the native photo URL', async () => {
    runtimeMock.wasmDetect.mockResolvedValue({
      error: null,
      width: 1280,
      height: 720,
      face: [{ embedding: embedding(), box: [100, 100, 200, 200] }],
    })
    const { scanGalleryPhoto } = await import('./galleryFaceScannerRuntime')

    const scan = await scanGalleryPhoto('42')

    expect(runtimeMock.backends).toEqual(['wasm'])
    expect(runtimeMock.configs[0]).toEqual(createFaceHumanConfig('wasm'))
    expect(runtimeMock.detectConfigs).toEqual([
      { filter: { width: 1280, height: 720 } },
    ])
    expect(new URL(runtimeMock.sources[0]!).pathname).toBe('/photo/42')
    expect(runtimeMock.sources[0]).not.toMatch(/^data:|^blob:/)
    expect(runtimeMock.sources.at(-1)).toBe('')
    expect(scan).toEqual({
      scannedAt: expect.any(String),
      faces: [expect.objectContaining({
        id: 'face-1',
        embedding: embedding(),
        minFacePixels: 200,
      })],
    })
  })

  it('keeps model-result and descriptor failures photo-specific on WASM', async () => {
    runtimeMock.wasmDetect.mockResolvedValue({
      error: 'This photo produced an invalid model result',
      width: 1280,
      height: 720,
      face: [],
    })
    const { scanGalleryPhoto } = await import('./galleryFaceScannerRuntime')

    await expect(scanGalleryPhoto('42')).rejects.toMatchObject({
      name: 'FacePhotoPipelineError',
    })
    expect(runtimeMock.backends).toEqual(['wasm'])
    expect(runtimeMock.cpuDetect).not.toHaveBeenCalled()
  })

  it('does not hot-switch a loaded runtime after a genuine WASM backend failure', async () => {
    runtimeMock.wasmDetect.mockRejectedValue(new Error('WASM backend kernel failed'))
    const { scanGalleryPhoto } = await import('./galleryFaceScannerRuntime')

    await expect(scanGalleryPhoto('42')).rejects.toMatchObject({
      name: 'GalleryFaceRuntimeError',
    })
    await expect(scanGalleryPhoto('43')).rejects.toMatchObject({
      name: 'GalleryFaceRuntimeError',
    })
    expect(runtimeMock.backends).toEqual(['wasm'])
    expect(runtimeMock.wasmDetect).toHaveBeenCalledOnce()
    expect(runtimeMock.cpuDetect).not.toHaveBeenCalled()
  })

  it('does not hot-switch when Human reports a WASM backend error in its result', async () => {
    runtimeMock.wasmDetect.mockResolvedValue({
      error: 'WASM backend unsupported kernel',
      width: 1280,
      height: 720,
      face: [],
    })
    const { scanGalleryPhoto } = await import('./galleryFaceScannerRuntime')

    await expect(scanGalleryPhoto('42')).rejects.toMatchObject({
      name: 'GalleryFaceRuntimeError',
    })
    expect(runtimeMock.backends).toEqual(['wasm'])
    expect(runtimeMock.cpuDetect).not.toHaveBeenCalled()
  })

  it('falls back to CPU when WASM fails before a runtime is loaded', async () => {
    runtimeMock.failWasmInit = true
    runtimeMock.cpuDetect.mockResolvedValue({
      error: null,
      width: 1280,
      height: 720,
      face: [],
    })
    const { scanGalleryPhoto } = await import('./galleryFaceScannerRuntime')

    await expect(scanGalleryPhoto('42')).resolves.toMatchObject({ faces: [] })
    expect(runtimeMock.backends).toEqual(['wasm', 'cpu'])
    expect(runtimeMock.disposed).toEqual(['wasm'])
  })
})
