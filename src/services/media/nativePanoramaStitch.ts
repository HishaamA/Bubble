import { Capacitor, registerPlugin } from '@capacitor/core'
import type { NativePanoramaCaptureResult } from '../../features/capture/nativePanoramaCapture'
import { readImageDimensions } from '../../features/capture/equirectangular'
import type { AiPanoramaReport, AiProcessedPanorama } from './aiPanorama'

export type NativeStitchProgress = { stage: string; progress: number }
export type NativeStitchStatus = { available: boolean; offline: boolean; model: string; error?: string }
export type NativeStitchJob = NativeStitchProgress & {
  jobId?: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  panoramaUrl?: string
  thumbnailUrl?: string
  width?: number
  height?: number
  report?: AiPanoramaReport
  error?: string
  code?: string
}
export type SavedNativeCapture = NativePanoramaCaptureResult & {
  sessionId?: string
  createdAt?: string | number
  assembly?: Partial<NativeStitchJob>
  savedResult?: Partial<NativeStitchJob>
}

export class NativePanoramaStitchError extends Error {
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'NativePanoramaStitchError'
    this.code = code
  }
}

export function isNativePanoramaMemoryFailure(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'out_of_memory')
}

type PanoramaStitchPlugin = {
  getStatus(): Promise<NativeStitchStatus>
  getCaptures(options: { ownerKey: string }): Promise<{ captures: SavedNativeCapture[] }>
  startStitch(options: { directoryUrl: string; ownerKey: string; outputWidth: number }): Promise<{ jobId: string }>
  getJob(options: { jobId: string; ownerKey: string }): Promise<NativeStitchJob>
  cancelStitch(options: { jobId: string; ownerKey: string }): Promise<unknown>
}

const PanoramaStitch = registerPlugin<PanoramaStitchPlugin>('PanoramaStitch')

type NativeBridgeReadOptions = { signal?: AbortSignal; timeoutMs?: number }
const NATIVE_BRIDGE_TIMEOUT_MS = 15_000

/** A missing bridge reply must not trap the UI or imply that the foreground worker stopped. */
function boundedNativeReply<T>(reply: Promise<T>, options: NativeBridgeReadOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      complete()
    }
    const abort = () => finish(() => reject(new DOMException('Stopped checking assembly status.', 'AbortError')))
    const timer = setTimeout(() => finish(() => reject(new NativePanoramaStitchError(
      'The phone has not returned assembly status yet. Assembly may still be running in the background. Your original photos are kept; reopen Capture to check again.',
      'native_bridge_timeout',
    ))), options.timeoutMs ?? NATIVE_BRIDGE_TIMEOUT_MS)
    options.signal?.addEventListener('abort', abort, { once: true })
    // Handlers remain attached after a timeout/abort so a late reply cannot update the UI
    // or cause an unhandled rejection. No native cancellation is sent by this read boundary.
    reply.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)))
    if (options.signal?.aborted) abort()
  })
}

/** Android always uses local stitching, including when a model needs attention. */
export function usesNativePanoramaStitch() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

export async function getNativePanoramaStitchStatus(options?: NativeBridgeReadOptions) {
  return boundedNativeReply(PanoramaStitch.getStatus(), options)
}

export async function getSavedNativeCaptures(ownerKey: string, options?: NativeBridgeReadOptions) {
  if (!ownerKey.trim()) return []
  const result = await boundedNativeReply(PanoramaStitch.getCaptures({ ownerKey }), options)
  // The native boundary also checks ownership; never display another identity's manifest.
  return result.captures.filter((capture) => capture.ownerKey === ownerKey)
}

export function isCompleteNativeCapture(capture: NativePanoramaCaptureResult) {
  return capture.targetCount > 0 && capture.capturedCount >= capture.targetCount
    && capture.frames.length >= capture.targetCount && capture.coverageComplete !== false
}

function requireActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Assembly stopped. Your original photos are kept.', 'AbortError')
}

function waitForNextPoll(milliseconds: number, signal?: AbortSignal) {
  requireActive(signal)
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('Assembly stopped.', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function localImage(url: string, fetcher: typeof fetch, signal?: AbortSignal) {
  if (!url.startsWith('file://')) throw new Error('The phone returned an invalid local image. Your originals are kept.')
  const response = await fetcher(Capacitor.convertFileSrc(url), { signal })
  if (!response.ok) throw new Error('The assembled image could not be read. Your originals are kept.')
  const blob = await response.blob()
  requireActive(signal)
  if (!blob.size || !blob.type.startsWith('image/')) throw new Error('The assembled image is incomplete. Your originals are kept.')
  return blob
}

async function readCompletedPanorama(
  capture: NativePanoramaCaptureResult,
  job: Partial<NativeStitchJob>,
  options: { ownerKey: string; signal?: AbortSignal; fetcher?: typeof fetch },
): Promise<AiProcessedPanorama> {
  if (!capture.directoryUrl || capture.ownerKey !== options.ownerKey || !options.ownerKey) {
    throw new Error('These original photos are not available for this account.')
  }
  requireActive(options.signal)
  if (!job.panoramaUrl || !job.thumbnailUrl || !job.width || !job.height || !Number.isInteger(job.width)
    || !Number.isInteger(job.height) || job.width !== job.height * 2 || job.width > 8192) {
    throw new Error('The phone returned an incomplete sphere. Your original photos are kept.')
  }
  const directory = new URL(`${capture.directoryUrl.replace(/\/+$/, '')}/`)
  for (const url of [job.panoramaUrl, job.thumbnailUrl]) {
    if (!url.startsWith('file://') || !new URL(url).href.startsWith(directory.href)) {
      throw new Error('The phone returned an invalid local image. Your originals are kept.')
    }
  }
  const fetcher = options.fetcher ?? fetch
  const [viewer, thumbnail] = await Promise.all([
    localImage(job.panoramaUrl, fetcher, options.signal), localImage(job.thumbnailUrl, fetcher, options.signal),
  ])
  const [viewerDimensions, thumbnailDimensions] = await Promise.all([
    readImageDimensions(new File([viewer], 'panorama.jpg', { type: viewer.type })),
    readImageDimensions(new File([thumbnail], 'thumbnail.jpg', { type: thumbnail.type })),
  ])
  requireActive(options.signal)
  if (viewerDimensions.width !== job.width || viewerDimensions.height !== job.height) {
    throw new Error('The assembled image dimensions do not match. Your originals are kept.')
  }
  return { viewer, thumbnail, viewerWidth: job.width, viewerHeight: job.height,
    thumbnailWidth: thumbnailDimensions.width, thumbnailHeight: thumbnailDimensions.height, report: job.report }
}

/** Reopens a durable completed result without running alignment again. */
export async function openSavedNativePanorama(
  capture: SavedNativeCapture,
  options: { ownerKey: string; signal?: AbortSignal; fetcher?: typeof fetch },
) {
  const completed = capture.savedResult?.state === 'completed' ? capture.savedResult : capture.assembly
  if (completed?.state !== 'completed') throw new Error('This capture has no finished sphere yet.')
  return readCompletedPanorama(capture, completed, options)
}

/** Polls the local worker; all source and result files remain owned by native storage. */
export async function assembleNativePanorama(
  capture: NativePanoramaCaptureResult,
  options: { ownerKey: string; signal?: AbortSignal; detachSignal?: AbortSignal; outputWidth?: 2048 | 4096;
    onProgress?: (progress: NativeStitchProgress) => void; pollIntervalMs?: number; bridgeTimeoutMs?: number; fetcher?: typeof fetch },
): Promise<AiProcessedPanorama> {
  if (!capture.directoryUrl || !options.ownerKey || capture.ownerKey !== options.ownerKey) {
    throw new Error('These original photos are not available for this account.')
  }
  if (!isCompleteNativeCapture(capture)) throw new Error('This capture is incomplete. Capture every direction before assembling a sphere.')
  requireActive(options.signal)
  requireActive(options.detachSignal)
  const polling = new AbortController()
  const detach = () => polling.abort()
  options.signal?.addEventListener('abort', detach, { once: true })
  options.detachSignal?.addEventListener('abort', detach, { once: true })
  if (options.signal?.aborted || options.detachSignal?.aborted) polling.abort()
  let jobId: string | undefined
  let cancellationSent = false
  const cancel = () => {
    if (cancellationSent || !jobId) return
    cancellationSent = true
    void PanoramaStitch.cancelStitch({ jobId, ownerKey: options.ownerKey }).catch(() => undefined)
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    const readOptions = { signal: polling.signal, timeoutMs: options.bridgeTimeoutMs }
    const status = await getNativePanoramaStitchStatus(readOptions)
    requireActive(polling.signal)
    if (!status.available || !status.offline) throw new Error(status.error || 'On-phone stitching is not ready. Your original photos are kept for retry.')
    options.onProgress?.({ stage: 'preparing', progress: 0 })
    requireActive(polling.signal)
    const starting = PanoramaStitch.startStitch({ directoryUrl: capture.directoryUrl, ownerKey: options.ownerKey, outputWidth: options.outputWidth ?? 4096 })
      .then((started) => {
        jobId = started.jobId
        // Stop can arrive before startStitch replies. A late acknowledged job is stopped
        // only for that explicit action, never because navigation or a read timed out.
        if (options.signal?.aborted) cancel()
        return started
      })
    await boundedNativeReply(starting, readOptions)
    requireActive(polling.signal)
    if (!jobId) throw new Error('The phone could not start assembly. Your original photos are kept.')
    const jobOptions = { jobId, ownerKey: options.ownerKey }
    const deadline = Date.now() + 30 * 60_000
    while (Date.now() < deadline) {
      requireActive(polling.signal)
      const job = await boundedNativeReply(PanoramaStitch.getJob(jobOptions), readOptions)
      requireActive(polling.signal)
      options.onProgress?.({ stage: job.stage, progress: Math.max(0, Math.min(1, job.progress || 0)) })
      if (job.state === 'failed') {
        throw new NativePanoramaStitchError(job.error || 'The photos could not be aligned reliably. Your originals are kept; retry or take a new capture.', job.code)
      }
      if (job.state === 'cancelled') {
        throw new DOMException('Assembly stopped. Your original photos are kept.', 'AbortError')
      }
      if (job.state === 'completed') {
        return await readCompletedPanorama(capture, job, { ...options, signal: polling.signal })
      }
      await waitForNextPoll(options.pollIntervalMs ?? 500, polling.signal)
    }
    throw new NativePanoramaStitchError('This status check has reached its time limit. Assembly may still be running in the background. Your original photos are kept; reopen Capture to check again.', 'native_status_timeout')
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    options.signal?.removeEventListener('abort', detach)
    options.detachSignal?.removeEventListener('abort', detach)
    // Status failures, deadlines and navigation detach the UI; only explicit Stop cancels.
    if (options.signal?.aborted) cancel()
  }
}

export function nativeStitchProgressLabel(stage: string) {
  const labels: Record<string, string> = {
    queued: 'Waiting to assemble', preparing: 'Preparing your original photos', loading: 'Loading the alignment model',
    features: 'Finding details in your photos', matching: 'Matching overlapping views', aligning: 'Aligning the sphere',
    alignment: 'Aligning the sphere', optimizing: 'Refining the alignment', projecting: 'Building the sphere',
    seams: 'Choosing clean joins', blending: 'Blending light and joins', checking: 'Checking sphere quality',
    validating: 'Checking sphere quality', encoding: 'Saving your assembled sphere', saving: 'Saving your assembled sphere',
  }
  return labels[stage] ?? 'Assembling on this phone'
}
