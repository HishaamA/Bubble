import { Capacitor } from '@capacitor/core'
import {
  nativeFrameSource,
  type NativePanoramaCaptureResult,
} from '../../features/capture/nativePanoramaCapture'
import type { ProcessedPanorama } from './processPanorama'
import { readImageDimensions } from '../../features/capture/equirectangular'

export type AiPanoramaProgress = {
  phase: string
  completed: number
  total: number
}

export type AiPanoramaHealth = {
  status: 'ok'
  aiAvailable: boolean
  device: string
  model: string
  loading?: boolean
}

export type AiPanoramaReport = {
  warnings?: string[]
  outputWidth?: number
  outputHeight?: number
  [key: string]: unknown
}

export type AiProcessedPanorama = ProcessedPanorama & {
  report?: AiPanoramaReport
}

type StitchJob = AiPanoramaProgress & {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  error?: string
  errorCode?: string
  report?: AiPanoramaReport
  width?: number
  height?: number
}

export class AiPanoramaError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'AiPanoramaError'
    this.code = code
  }
}

type StitchOptions = {
  signal?: AbortSignal
  onProgress?: (progress: AiPanoramaProgress) => void
  baseUrl?: string
  fetcher?: typeof fetch
  pollIntervalMs?: number
}

/** Native builds need an explicit reachable service; browsers use the dev proxy. */
export function aiPanoramaServiceUrl() {
  const configured = import.meta.env.VITE_STITCH_SERVICE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return Capacitor.isNativePlatform() ? undefined : '/api/stitch'
}

export function isAiPanoramaCancellation(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

function requireNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Assembly cancelled.', 'AbortError')
}

async function request<T>(
  fetcher: typeof fetch,
  url: string,
  consume: (response: Response) => Promise<T>,
  options: RequestInit = {},
  timeoutMs = 30_000,
) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timer = setTimeout(abort, timeoutMs)
  try {
    const response = await fetcher(url, { ...options, signal: controller.signal })
    // Keep both cancellation and the deadline connected until the response body
    // is consumed, not merely until the server sends its response headers.
    return await consume(response)
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('Assembly cancelled.', 'AbortError')
    if (controller.signal.aborted) throw new Error('The stitching service took too long to respond. Your source photos are safe.')
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

export async function checkAiPanoramaHealth(options: StitchOptions = {}): Promise<AiPanoramaHealth | null> {
  const baseUrl = options.baseUrl ?? aiPanoramaServiceUrl()
  if (!baseUrl) return null
  try {
    const health = await request<AiPanoramaHealth>(options.fetcher ?? fetch, `${baseUrl}/health`, readJson, {
      signal: options.signal,
    }, 3_000)
    return health.status === 'ok' && typeof health.aiAvailable === 'boolean' ? health : null
  } catch (error) {
    if (options.signal?.aborted) throw error
    return null
  }
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { error?: string; detail?: string }
    if (typeof body.error === 'string') return body.error
    if (typeof body.detail === 'string') return body.detail
  } catch { /* HTML proxy failures use the readable fallback below. */ }
  return `Stitching could not continue (${response.status}). Your source photos are safe.`
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await responseError(response))
  return response.json() as Promise<T>
}

async function readBlob(response: Response) {
  if (!response.ok) throw new Error(await responseError(response))
  return response.blob()
}

function pause(milliseconds: number, signal?: AbortSignal) {
  requireNotAborted(signal)
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('Assembly cancelled.', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function runStitchJob(form: FormData, options: StitchOptions): Promise<AiProcessedPanorama> {
  const baseUrl = options.baseUrl ?? aiPanoramaServiceUrl()
  if (!baseUrl) throw new Error('Connect this app to the stitching computer before assembling source photos.')
  const fetcher = options.fetcher ?? fetch
  let jobId: string | undefined
  try {
    requireNotAborted(options.signal)
    options.onProgress?.({ phase: 'uploading', completed: 0, total: 0 })
    const payload = await request<{ id?: string }>(fetcher, `${baseUrl}/jobs`, readJson, {
      method: 'POST', body: form, signal: options.signal,
    }, 180_000)
    if (!payload.id || !/^[a-zA-Z0-9_-]+$/.test(payload.id)) {
      throw new Error('The stitching service returned an invalid job.')
    }
    jobId = payload.id
    const deadline = Date.now() + 30 * 60_000
    while (Date.now() < deadline) {
      requireNotAborted(options.signal)
      const job = await request<StitchJob>(fetcher, `${baseUrl}/jobs/${jobId}`, readJson, { signal: options.signal })
      options.onProgress?.({ phase: job.phase || job.status, completed: job.completed || 0, total: job.total || 0 })
      if (job.status === 'failed') throw new AiPanoramaError(job.error || 'These photos could not be aligned reliably. Try a new capture with more overlap.', job.errorCode || 'quality_rejected')
      if (job.status === 'cancelled') throw new DOMException('Assembly cancelled.', 'AbortError')
      if (job.status === 'completed') {
        options.onProgress?.({ phase: 'downloading', completed: 0, total: 0 })
        const [viewer, thumbnail] = await Promise.all([
          request(fetcher, `${baseUrl}/jobs/${jobId}/panorama`, readBlob, { signal: options.signal }),
          request(fetcher, `${baseUrl}/jobs/${jobId}/thumbnail`, readBlob, { signal: options.signal }),
        ])
        if (!viewer.size || !thumbnail.size || !viewer.type.startsWith('image/') || !thumbnail.type.startsWith('image/')) {
          throw new Error('The stitching service did not return a finished image.')
        }
        const width = job.width
        const height = job.height
        if (!width || !height || !Number.isInteger(width) || width !== height * 2 || width > 8192) {
          throw new Error('The stitching service did not return valid sphere dimensions.')
        }
        const thumbnailDimensions = await readImageDimensions(new File([thumbnail], 'thumbnail.jpg', { type: thumbnail.type }))
        requireNotAborted(options.signal)
        return {
          viewer, thumbnail,
          viewerWidth: width,
          viewerHeight: height,
          thumbnailWidth: thumbnailDimensions.width,
          thumbnailHeight: thumbnailDimensions.height,
          report: job.report,
        }
      }
      await pause(options.pollIntervalMs ?? 1_000, options.signal)
    }
    throw new Error('Assembly took too long. Your source photos are safe; try again when the stitching computer is ready.')
  } finally {
    // Service copies are temporary. The caller owns its original files and only
    // releases native capture storage after the panorama has been saved.
    if (jobId) {
      await request(fetcher, `${baseUrl}/jobs/${jobId}`, async (response) => { await response.arrayBuffer() }, { method: 'DELETE' }, 3_000).catch(() => undefined)
    }
  }
}

/** Sends original frames and camera calibration, never the already flattened sphere. */
export async function assembleAiNativePanorama(
  capture: NativePanoramaCaptureResult,
  options: StitchOptions = {},
): Promise<AiProcessedPanorama> {
  const form = new FormData()
  const metadata = []
  for (let index = 0; index < capture.frames.length; index += 1) {
    requireNotAborted(options.signal)
    const frame = capture.frames[index]!
    options.onProgress?.({ phase: 'reading', completed: index, total: capture.frames.length })
    const blob = await request(options.fetcher ?? fetch, nativeFrameSource(frame), readBlob, { signal: options.signal })
    if (!blob.size) throw new Error(`Source photo ${index + 1} is empty.`)
    const fileName = `frame-${String(index).padStart(3, '0')}.jpg`
    form.append('frames', blob, fileName)
    const { uri: _uri, fileUrl: _fileUrl, path: _path, ...calibration } = frame
    metadata.push({ ...calibration, fileName })
  }
  form.append('manifest', JSON.stringify({ version: 1, outputWidth: 4096, frames: metadata }))
  return runStitchJob(form, options)
}

/** Assembles overlapping camera photos; unconnected or incomplete sets may be rejected. */
export async function assembleAiPhotoPanorama(
  files: File[],
  options: StitchOptions = {},
): Promise<AiProcessedPanorama> {
  if (files.length < 8 || files.length > 64) throw new Error('Choose 8–64 overlapping photos from the same place, including the ceiling and floor.')
  if (files.some((file) => file.type !== 'image/jpeg')) {
    throw new Error('Choose JPEG source photos. Export HEIC or other formats as JPEG first.')
  }
  if (files.some((file) => file.size > 12 * 1024 * 1024) || files.reduce((bytes, file) => bytes + file.size, 0) > 180 * 1024 * 1024) {
    throw new Error('Choose photos smaller than 12 MB each and 180 MB in total.')
  }
  const form = new FormData()
  const frames = files.map((file, index) => {
    const fileName = `frame-${String(index).padStart(3, '0')}.jpg`
    form.append('frames', file, fileName)
    return { fileName }
  })
  form.append('manifest', JSON.stringify({ version: 1, outputWidth: 4096, projection: 'unposed', frames }))
  return runStitchJob(form, options)
}

export function aiPanoramaProgressLabel(progress: AiPanoramaProgress) {
  const phases: Record<string, string> = {
    reading: 'Preparing original photos', uploading: 'Sending photos to the stitching computer',
    queued: 'Waiting for the stitching computer', loading: 'Loading the alignment model', preparing: 'Preparing the alignment engine',
    matching: 'Matching details between photos', features: 'Finding shared visual details',
    alignment: 'Aligning camera views', aligning: 'Aligning camera views',
    optimizing: 'Refining the camera alignment', projecting: 'Building the sphere',
    seams: 'Choosing clean image joins', blending: 'Balancing light and blending joins',
    rendering: 'Rendering your 360° moment', saving: 'Finishing the image', encoding: 'Finishing the image',
    downloading: 'Receiving your finished sphere',
  }
  const label = phases[progress.phase] ?? 'Assembling your 360° moment'
  return progress.total > 0 ? `${label} · ${Math.min(progress.completed, progress.total)} / ${progress.total}` : `${label}…`
}
