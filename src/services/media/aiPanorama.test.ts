import { describe, expect, it, vi } from 'vitest'
vi.mock('../../features/capture/equirectangular', () => ({ readImageDimensions: vi.fn().mockResolvedValue({ width: 640, height: 320 }) }))
import {
  assembleAiNativePanorama,
  assembleAiPhotoPanorama,
  checkAiPanoramaHealth,
} from './aiPanorama'

const baseUrl = 'http://stitch.test/api/stitch'
const photos = () => Array.from({ length: 8 }, (_, index) => new File(['photo'], `photo-${index}.jpg`, { type: 'image/jpeg' }))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const image = () => ({ ok: true, blob: async () => new Blob(['jpeg bytes'], { type: 'image/jpeg' }) }) as Response

describe('AI panorama service client', () => {
  it('reports unavailable services without treating an HTML proxy response as AI readiness', async () => {
    expect(await checkAiPanoramaHealth({ baseUrl, fetcher: vi.fn().mockRejectedValue(new TypeError('network')) })).toBeNull()
    expect(await checkAiPanoramaHealth({ baseUrl, fetcher: vi.fn().mockResolvedValue(new Response('<html>app</html>')) })).toBeNull()
    expect(await checkAiPanoramaHealth({ baseUrl, fetcher: vi.fn().mockResolvedValue(json({ status: 'ok', aiAvailable: false, loading: true, device: 'cpu', model: 'LightGlue' })) })).toMatchObject({ aiAvailable: false, loading: true })
  })

  it('keeps cancellation connected while a health response body is still streaming', async () => {
    const controller = new AbortController()
    let readingBody!: () => void
    const bodyStarted = new Promise<void>((resolve) => { readingBody = resolve })
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        readingBody()
      }),
    }) as Response)
    const health = checkAiPanoramaHealth({ baseUrl, fetcher, signal: controller.signal })
    await bodyStarted
    controller.abort()
    await expect(health).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uploads originals, polls actual progress, downloads both derivatives and releases the service copy', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: 'job-1' }, 202))
      .mockResolvedValueOnce(json({ id: 'job-1', status: 'running', phase: 'matching', completed: 4, total: 12 }))
      .mockResolvedValueOnce(json({ id: 'job-1', status: 'completed', phase: 'finished', width: 4096, height: 2048, report: { warnings: ['Some floor coverage is missing.'] } }))
      .mockResolvedValueOnce(image()).mockResolvedValueOnce(image())
      .mockResolvedValueOnce(json({ status: 'cancelled' }))
    const onProgress = vi.fn()
    const result = await assembleAiPhotoPanorama(photos(), { baseUrl, fetcher, onProgress, pollIntervalMs: 0 })
    expect(result).toMatchObject({ viewerWidth: 4096, viewerHeight: 2048, report: { warnings: ['Some floor coverage is missing.'] } })
    expect(result.viewer.size).toBeGreaterThan(0)
    const form = fetcher.mock.calls[0]![1]!.body as FormData
    expect(form.getAll('frames')).toHaveLength(8)
    expect(JSON.parse(form.get('manifest') as string)).toMatchObject({ version: 1, outputWidth: 4096, projection: 'unposed', frames: [{ fileName: 'frame-000.jpg' }, ...Array.from({ length: 7 }, (_, index) => ({ fileName: `frame-00${index + 1}.jpg` }))] })
    expect(onProgress).toHaveBeenCalledWith({ phase: 'matching', completed: 4, total: 12 })
    expect(fetcher).toHaveBeenLastCalledWith(`${baseUrl}/jobs/job-1`, expect.objectContaining({ method: 'DELETE' }))
  })

  it('keeps camera calibration while stripping local native paths from the uploaded manifest', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(image())
      .mockResolvedValueOnce(json({ id: 'native-1' }, 202))
      .mockResolvedValueOnce(json({ status: 'completed', width: 4096, height: 2048 }))
      .mockResolvedValueOnce(image()).mockResolvedValueOnce(image())
      .mockResolvedValueOnce(json({ status: 'cancelled' }))
    await assembleAiNativePanorama({ targetCount: 1, capturedCount: 1, frames: [{
      uri: 'file:///private/capture/photo.jpg', path: '/private/photo.jpg', fileUrl: 'file:///private/photo.jpg',
      width: 1920, height: 1440, yawDegrees: 15, horizontalFovDegrees: 60,
      intrinsics: [1000, 0, 0, 0, 1000, 0, 960, 720, 1],
    }] }, { baseUrl, fetcher, pollIntervalMs: 0 })
    const form = fetcher.mock.calls[1]![1]!.body as FormData
    const manifest = JSON.parse(form.get('manifest') as string)
    expect(manifest.frames[0]).toMatchObject({ width: 1920, height: 1440, yawDegrees: 15, horizontalFovDegrees: 60 })
    expect(form.get('manifest')).not.toContain('private')
    expect(manifest.frames[0].intrinsics).toHaveLength(9)
  })

  it('cancels a running job without downloading or silently restarting assembly', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: 'cancel-1' }, 202))
      .mockResolvedValueOnce(json({ status: 'running', phase: 'matching', completed: 1, total: 10 }))
      .mockResolvedValueOnce(json({ status: 'cancelled' }))
    await expect(assembleAiPhotoPanorama(photos(), {
      baseUrl, fetcher, signal: controller.signal,
      onProgress: (progress) => { if (progress.phase === 'matching') controller.abort() },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher).toHaveBeenLastCalledWith(`${baseUrl}/jobs/cancel-1`, expect.objectContaining({ method: 'DELETE' }))
  })

  it('surfaces inadequate coverage failures and releases temporary service data', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: 'failed-1' }, 202))
      .mockResolvedValueOnce(json({ status: 'failed', error: 'These photos do not cover a full sphere.' }))
      .mockResolvedValueOnce(json({ status: 'cancelled' }))
    await expect(assembleAiPhotoPanorama(photos(), { baseUrl, fetcher })).rejects.toThrow('do not cover a full sphere')
    expect(fetcher).toHaveBeenLastCalledWith(`${baseUrl}/jobs/failed-1`, expect.objectContaining({ method: 'DELETE' }))
  })

  it('rejects unusable source sets before any upload', async () => {
    const fetcher = vi.fn()
    await expect(assembleAiPhotoPanorama(photos().slice(0, 2), { fetcher })).rejects.toThrow('8–64')
    await expect(assembleAiPhotoPanorama([...photos().slice(0, 7), new File(['x'], 'raw.heic', { type: 'image/heic' })], { fetcher })).rejects.toThrow('JPEG')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
