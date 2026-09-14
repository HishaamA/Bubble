import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ getStatus: vi.fn(), getCaptures: vi.fn(), startStitch: vi.fn(), getJob: vi.fn(), cancelStitch: vi.fn() }))
vi.mock('@capacitor/core', () => ({
  registerPlugin: () => bridge,
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', convertFileSrc: (url: string) => `https://localhost/_capacitor_file_${url.slice(7)}` },
}))
vi.mock('../../features/capture/equirectangular', () => ({
  readImageDimensions: vi.fn(async (file: File) => file.name === 'panorama.jpg' ? { width: 4096, height: 2048 } : { width: 640, height: 320 }),
}))
import { assembleNativePanorama, getSavedNativeCaptures, usesNativePanoramaStitch, openSavedNativePanorama, isNativePanoramaMemoryFailure } from './nativePanoramaStitch'
import { readImageDimensions } from '../../features/capture/equirectangular'

const ownerKey = 'clerk:offline-owner'
const capture = { ownerKey, directoryUrl: 'file:///data/user/0/bubble/files/capture', targetCount: 8, capturedCount: 8,
  frames: Array.from({ length: 8 }, () => ({ width: 1440, height: 1920 })) }
const finished = { state: 'completed' as const, stage: 'checking', progress: 1, width: 4096, height: 2048,
  panoramaUrl: `${capture.directoryUrl}/panorama.jpg`, thumbnailUrl: `${capture.directoryUrl}/thumbnail.jpg`,
  report: { aiUsed: true, warnings: ['Check nearby objects.'] } }
const imageResponse = () => ({ ok: true, blob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }) }) as Response

beforeEach(() => {
  vi.clearAllMocks()
  bridge.getStatus.mockResolvedValue({ available: true, offline: true, model: 'DISK + LightGlue' })
  bridge.startStitch.mockResolvedValue({ jobId: 'local-job' })
  bridge.cancelStitch.mockResolvedValue({})
  bridge.getJob.mockResolvedValue(finished)
})

afterEach(() => vi.useRealTimers())

describe('native offline panorama assembly', () => {
  it('reads only local result files, reports actual stages and retains all native files', async () => {
    bridge.getJob.mockResolvedValueOnce({ state: 'running', stage: 'matching', progress: 0.24 }).mockResolvedValue(finished)
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => imageResponse())
    const onProgress = vi.fn()
    const result = await assembleNativePanorama(capture, { ownerKey, fetcher, onProgress, pollIntervalMs: 0 })
    expect(usesNativePanoramaStitch()).toBe(true)
    expect(bridge.startStitch).toHaveBeenCalledWith({ ownerKey, directoryUrl: capture.directoryUrl, outputWidth: 4096 })
    expect(bridge.getJob).toHaveBeenCalledWith({ ownerKey, jobId: 'local-job' })
    expect(onProgress).toHaveBeenCalledWith({ stage: 'matching', progress: 0.24 })
    expect(result).toMatchObject({ viewerWidth: 4096, thumbnailWidth: 640, report: finished.report })
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('https://localhost/_capacitor_file_/'))).toBe(true)
    expect(bridge.cancelStitch).not.toHaveBeenCalled()
  })

  it('scopes persisted originals to their signed-in owner, including incomplete sets', async () => {
    bridge.getCaptures.mockResolvedValue({ captures: [capture, { ...capture, capturedCount: 4 }, { ...capture, ownerKey: 'clerk:other' }, { ...capture, ownerKey: undefined }] })
    expect(await getSavedNativeCaptures(ownerKey)).toHaveLength(2)
    expect(bridge.getCaptures).toHaveBeenCalledWith({ ownerKey })
    await expect(assembleNativePanorama({ ...capture, ownerKey: 'clerk:other' }, { ownerKey })).rejects.toThrow('this account')
    expect(bridge.startStitch).not.toHaveBeenCalled()
  })

  it('rejects incomplete sources and unavailable models without attempting a rough result', async () => {
    await expect(assembleNativePanorama({ ...capture, capturedCount: 4 }, { ownerKey })).rejects.toThrow('incomplete')
    await expect(assembleNativePanorama({ ...capture, coverageComplete: false }, { ownerKey })).rejects.toThrow('incomplete')
    bridge.getStatus.mockResolvedValue({ available: false, offline: true, model: 'DISK + LightGlue' })
    await expect(assembleNativePanorama(capture, { ownerKey })).rejects.toThrow('original photos are kept')
    expect(bridge.startStitch).not.toHaveBeenCalled()
  })

  it('surfaces quality failure without downloading or removing originals', async () => {
    bridge.getJob.mockResolvedValue({ state: 'failed', stage: 'checking', progress: 0.95, error: 'Too much movement between views.' })
    const fetcher = vi.fn()
    await expect(assembleNativePanorama(capture, { ownerKey, fetcher })).rejects.toThrow('Too much movement')
    expect(fetcher).not.toHaveBeenCalled()
    expect(bridge.cancelStitch).not.toHaveBeenCalled()
  })

  it('cooperatively stops a worker with the same owner while preserving source storage', async () => {
    const controller = new AbortController()
    bridge.getJob.mockResolvedValue({ state: 'running', stage: 'matching', progress: 0.3 })
    await expect(assembleNativePanorama(capture, { ownerKey, signal: controller.signal,
      onProgress: (progress) => { if (progress.stage === 'matching') controller.abort() },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(bridge.cancelStitch).toHaveBeenCalledWith({ ownerKey, jobId: 'local-job' })
  })

  it('rejects remote result URLs and decoded dimensions that do not match the result', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => imageResponse())
    bridge.getJob.mockResolvedValueOnce({ ...finished, panoramaUrl: 'https://unrelated.example/image.jpg' })
    await expect(assembleNativePanorama(capture, { ownerKey, fetcher })).rejects.toThrow('invalid local image')
    expect(fetcher).not.toHaveBeenCalledWith('https://unrelated.example/image.jpg', expect.anything())
    vi.mocked(readImageDimensions).mockResolvedValueOnce({ width: 100, height: 50 })
    await expect(assembleNativePanorama(capture, { ownerKey, fetcher })).rejects.toThrow('dimensions do not match')
  })

  it('opens a retained completed sphere without loading models or starting another job', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => imageResponse())
    const result = await openSavedNativePanorama({ ...capture, assembly: finished }, { ownerKey, fetcher })
    expect(result.viewerWidth).toBe(4096)
    expect(bridge.startStitch).not.toHaveBeenCalled()
    expect(bridge.getStatus).not.toHaveBeenCalled()
  })

  it('opens the previous successful sphere after a later retry failed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => imageResponse())
    const result = await openSavedNativePanorama({ ...capture,
      assembly: { state: 'failed', code: 'quality_rejected' }, savedResult: finished,
    }, { ownerKey, fetcher })
    expect(result.viewerWidth).toBe(4096)
    expect(bridge.startStitch).not.toHaveBeenCalled()
  })

  it('detaches polling on navigation while the native worker continues', async () => {
    const detachment = new AbortController()
    bridge.getJob.mockResolvedValue({ state: 'running', stage: 'matching', progress: 0.3 })
    await expect(assembleNativePanorama(capture, { ownerKey, detachSignal: detachment.signal,
      onProgress: (progress) => { if (progress.stage === 'matching') detachment.abort() },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(bridge.cancelStitch).not.toHaveBeenCalled()
  })

  it('preserves memory failure codes and changes resolution only when explicitly requested', async () => {
    bridge.getJob.mockResolvedValueOnce({ state: 'failed', stage: 'blending', progress: 0.85, error: 'Memory exhausted.', code: 'out_of_memory' })
    const failure = await assembleNativePanorama(capture, { ownerKey }).catch((error: unknown) => error)
    expect(isNativePanoramaMemoryFailure(failure)).toBe(true)
    expect(bridge.startStitch).toHaveBeenLastCalledWith(expect.objectContaining({ outputWidth: 4096 }))
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => imageResponse())
    await assembleNativePanorama(capture, { ownerKey, outputWidth: 2048, fetcher })
    expect(bridge.startStitch).toHaveBeenLastCalledWith(expect.objectContaining({ outputWidth: 2048 }))
  })

  it('bounds an unresponsive getJob reply without cancelling or accepting its late result', async () => {
    vi.useFakeTimers()
    let finishRead: ((job: typeof finished) => void) | undefined
    bridge.getJob.mockImplementation(() => new Promise((resolve) => { finishRead = resolve }))
    const fetcher = vi.fn()
    const outcome = assembleNativePanorama(capture, { ownerKey, fetcher, bridgeTimeoutMs: 25 })
      .catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(25)
    expect(await outcome).toMatchObject({ code: 'native_bridge_timeout', message: expect.stringContaining('may still be running') })
    expect(bridge.cancelStitch).not.toHaveBeenCalled()
    expect(bridge.getJob).toHaveBeenCalledTimes(1)
    finishRead?.(finished)
    await vi.advanceTimersByTimeAsync(500)
    expect(fetcher).not.toHaveBeenCalled()
    expect(bridge.getJob).toHaveBeenCalledTimes(1)
  })

  it('bounds recovery reads and aborts them on navigation without touching the worker', async () => {
    vi.useFakeTimers()
    bridge.getCaptures.mockImplementation(() => new Promise(() => undefined))
    const timeout = getSavedNativeCaptures(ownerKey, { timeoutMs: 25 }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(25)
    expect(await timeout).toMatchObject({ code: 'native_bridge_timeout' })
    const controller = new AbortController()
    const aborted = getSavedNativeCaptures(ownerKey, { signal: controller.signal }).catch((error: unknown) => error)
    controller.abort()
    expect(await aborted).toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
    expect(bridge.startStitch).not.toHaveBeenCalled()
    expect(bridge.cancelStitch).not.toHaveBeenCalled()
  })

  it('detaches an unresolved native read promptly without requiring its callback', async () => {
    vi.useFakeTimers()
    const detachment = new AbortController()
    bridge.getJob.mockImplementation(() => new Promise(() => undefined))
    const outcome = assembleNativePanorama(capture, { ownerKey, detachSignal: detachment.signal }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(bridge.getJob).toHaveBeenCalledTimes(1)
    detachment.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(bridge.cancelStitch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still honors explicit Stop when the start acknowledgement arrives late', async () => {
    vi.useFakeTimers()
    let started: ((value: { jobId: string }) => void) | undefined
    bridge.startStitch.mockImplementation(() => new Promise((resolve) => { started = resolve }))
    const controller = new AbortController()
    const outcome = assembleNativePanorama(capture, { ownerKey, signal: controller.signal }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(bridge.cancelStitch).not.toHaveBeenCalled()
    started?.({ jobId: 'late-job' })
    await vi.advanceTimersByTimeAsync(0)
    expect(bridge.cancelStitch).toHaveBeenCalledExactlyOnceWith({ jobId: 'late-job', ownerKey })
    expect(bridge.getJob).not.toHaveBeenCalled()
  })
})
