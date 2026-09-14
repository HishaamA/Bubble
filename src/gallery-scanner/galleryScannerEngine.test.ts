import { describe, expect, it, vi } from 'vitest'
import { FacePhotoPipelineError } from '../features/journal/people/faceRecognitionPipeline'
import type { StoredPhotoFaceScan } from '../features/journal/people/types'
import { GalleryFaceRuntimeError } from './galleryFaceScannerRuntime'
import {
  installGalleryScannerEngine,
  validateGalleryScanRequest,
  type BubbleGalleryHost,
} from './galleryScannerEngine'

const firstRequest = {
  token: '2a809f22-cc75-4f64-822e-cc89a29fe547',
  key: 'journal-photo:device-gallery:42:2026-09-14T08%3A00%3A00.000Z',
  nativeId: '42',
}

const emptyScan: StoredPhotoFaceScan = {
  scannedAt: '2026-09-14T08:01:00.000Z',
  faces: [],
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function host(): BubbleGalleryHost {
  return {
    ready: vi.fn(),
    complete: vi.fn(),
    failed: vi.fn(),
  }
}

describe('isolated gallery scanner bridge', () => {
  it('announces readiness and returns only the stored face-scan JSON', async () => {
    const nativeHost = host()
    const scanPhoto = vi.fn().mockResolvedValue(emptyScan)
    const target: { BubbleGalleryEngine?: { scan: (request: unknown) => void } } = {}

    const engine = installGalleryScannerEngine(target, nativeHost, scanPhoto)
    expect(target.BubbleGalleryEngine).toBe(engine)
    expect(nativeHost.ready).toHaveBeenCalledOnce()

    engine.scan(firstRequest)
    await vi.waitFor(() => expect(nativeHost.complete).toHaveBeenCalledOnce())
    expect(scanPhoto).toHaveBeenCalledWith('42')
    expect(nativeHost.complete).toHaveBeenCalledWith(
      firstRequest.token,
      JSON.stringify(emptyScan),
    )
    expect(nativeHost.failed).not.toHaveBeenCalled()
  })

  it('admits only one operation and accepts the next after completion', async () => {
    const nativeHost = host()
    const pending = deferred<StoredPhotoFaceScan>()
    const scanPhoto = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(emptyScan)
    const engine = installGalleryScannerEngine({}, nativeHost, scanPhoto)
    const second = {
      token: '6b945fd3-54a3-4e36-a8e1-797f8fdca7bb',
      key: 'journal-photo:device-gallery:43:',
      nativeId: '43',
    }

    engine.scan(firstRequest)
    engine.scan(second)
    expect(scanPhoto).toHaveBeenCalledTimes(1)
    expect(nativeHost.failed).toHaveBeenCalledWith(second.token, 'engine:busy')

    pending.resolve(emptyScan)
    await vi.waitFor(() => expect(nativeHost.complete).toHaveBeenCalledOnce())
    engine.scan(second)
    await vi.waitFor(() => expect(nativeHost.complete).toHaveBeenCalledTimes(2))
    expect(scanPhoto).toHaveBeenLastCalledWith('43')
  })

  it.each([
    null,
    { ...firstRequest, token: 'not-a-uuid' },
    { ...firstRequest, nativeId: '0' },
    { ...firstRequest, nativeId: '../42' },
    { ...firstRequest, nativeId: '9223372036854775808', key: 'journal-photo:device-gallery:9223372036854775808:' },
    { ...firstRequest, key: 'journal-photo:device-gallery:41:' },
    { ...firstRequest, key: `journal-photo:device-gallery:42:${'x'.repeat(2048)}` },
    { ...firstRequest, key: 'journal-photo:device-gallery:42:\n' },
  ])('rejects malformed native input without reading a photo: %j', (request) => {
    const nativeHost = host()
    const scanPhoto = vi.fn().mockResolvedValue(emptyScan)
    const engine = installGalleryScannerEngine({}, nativeHost, scanPhoto)

    expect(validateGalleryScanRequest(request)).toBeNull()
    engine.scan(request)

    expect(scanPhoto).not.toHaveBeenCalled()
    expect(nativeHost.failed).toHaveBeenCalledWith(
      typeof request?.token === 'string' && request.token.length <= 128
        ? request.token
        : '',
      'request:invalid',
    )
  })

  it.each([
    [new FacePhotoPipelineError(), 'photo:scan-failed'],
    [new GalleryFaceRuntimeError(), 'runtime:unavailable'],
    [new Error('private path C:/secret/photo.jpg'), 'runtime:unexpected'],
  ])('reports a bounded failure class without leaking exception details', async (error, reason) => {
    const nativeHost = host()
    const engine = installGalleryScannerEngine(
      {},
      nativeHost,
      vi.fn().mockRejectedValue(error),
    )

    engine.scan(firstRequest)

    await vi.waitFor(() => expect(nativeHost.failed).toHaveBeenCalledWith(
      firstRequest.token,
      reason,
    ))
    expect(JSON.stringify(vi.mocked(nativeHost.failed).mock.calls)).not.toContain('secret')
  })

  it('bounds bridge payloads and safely rejects an unserializable result', async () => {
    const oversizedHost = host()
    const oversized = {
      ...emptyScan,
      padding: 'x'.repeat(700_000),
    } as unknown as StoredPhotoFaceScan
    const oversizedEngine = installGalleryScannerEngine(
      {},
      oversizedHost,
      vi.fn().mockResolvedValue(oversized),
    )

    oversizedEngine.scan(firstRequest)
    await vi.waitFor(() => expect(oversizedHost.failed).toHaveBeenCalledWith(
      firstRequest.token,
      'result:too-large',
    ))
    expect(oversizedHost.complete).not.toHaveBeenCalled()

    const cyclicHost = host()
    const cyclic = { ...emptyScan } as StoredPhotoFaceScan & { self?: unknown }
    cyclic.self = cyclic
    const cyclicEngine = installGalleryScannerEngine(
      {},
      cyclicHost,
      vi.fn().mockResolvedValue(cyclic),
    )

    cyclicEngine.scan(firstRequest)
    await vi.waitFor(() => expect(cyclicHost.failed).toHaveBeenCalledWith(
      firstRequest.token,
      'runtime:unexpected',
    ))
    expect(cyclicHost.complete).not.toHaveBeenCalled()
  })
})
