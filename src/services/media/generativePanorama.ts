import { Capacitor } from '@capacitor/core'
import { validateGeneratedPanorama } from './validateGeneratedPanorama'

export type GenerationHealth = {
  ready: boolean
  provider: 'local'
  model: string
  maxPhotos: number
  reason?: string
  device?: string
}
export type GenerationJob = {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'submission-unknown'
  stage: string
  error?: string
  provider?: 'local'
  model?: string
  referenceCount?: number
  createdAt?: string
  generatedAt?: string
}
type RequestOptions = { signal?: AbortSignal; baseUrl?: string; fetcher?: typeof fetch }
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export class GenerationRequestError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GenerationRequestError'
    this.status = status
  }
}
export function generationServiceUrl() {
  const configured = import.meta.env.VITE_GENERATION_SERVICE_URL?.trim().replace(/\/+$/, '')
  if (configured) return configured
  if (!Capacitor.isNativePlatform()) return '/api/generation'
  // Debug/demo APKs can reach their own computer through an explicit adb
  // reverse mapping. Release builds still require a configured trusted URL.
  return import.meta.env.VITE_DEMO_LOGIN_ENABLED === 'true'
    ? 'http://127.0.0.1:8788/api/generation'
    : undefined
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Request paused. Your draft is saved.', 'AbortError')
}
async function request<T>(path: string, consume: (response: Response) => Promise<T>, options: RequestOptions, init: RequestInit = {}, timeout = 30_000) {
  const base = options.baseUrl ?? generationServiceUrl()
  if (!base) throw new GenerationRequestError('Connect this app to your generation computer first. Your photos stay saved on this device.')
  checkAbort(options.signal)
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeout)
  try {
    const response = await (options.fetcher ?? fetch)(`${base}${path}`, { ...init, signal: controller.signal })
    if (!response.ok) {
      const value = await response.json().catch(() => null) as { error?: string } | null
      throw new GenerationRequestError(value?.error || `The generation computer could not respond (${response.status}).`, response.status)
    }
    return await consume(response)
  } catch (error) {
    checkAbort(options.signal)
    if (error instanceof GenerationRequestError) throw error
    if (controller.signal.aborted) throw new GenerationRequestError('The computer took too long to reply. Check this draft’s status before starting another generation.')
    throw new GenerationRequestError('Could not reach your generation computer. Keep it running and reconnect; your photos are saved.')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
export async function getGenerationHealth(options: RequestOptions = {}): Promise<GenerationHealth> {
  try {
    const value = await request('/health', (response) => response.json(), options)
    if (typeof value.ready !== 'boolean' || value.provider !== 'local' || typeof value.model !== 'string') throw new Error('Invalid generation service.')
    return { ...value, maxPhotos: 4 }
  } catch (error) {
    checkAbort(options.signal)
    return { ready: false, provider: 'local', model: '', maxPhotos: 4, reason: error instanceof Error ? error.message : 'Your generation computer is not ready.' }
  }
}
function readJob(value: unknown, id: string): GenerationJob {
  const job = value as GenerationJob | null
  if (!job || job.id !== id || !['queued', 'running', 'completed', 'failed', 'submission-unknown'].includes(job.status) || typeof job.stage !== 'string') throw new GenerationRequestError('The computer returned an invalid job status. Your saved photos have not changed.')
  return job
}
export async function getGenerationJob(id: string, options: RequestOptions = {}): Promise<GenerationJob> {
  if (!JOB_ID.test(id)) throw new GenerationRequestError('This draft has an invalid job ID.')
  return request(`/jobs/${id}`, async (response) => readJob(await response.json(), id), options)
}

/** Make a modest, metadata-free transfer copy; the original File stays in the
 * account-scoped draft store. Never force a reference into panorama dimensions. */
export async function prepareGenerationReference(file: File): Promise<{ type: 'image/jpeg'; data: string }> {
  if (!file.size || file.size > 30 * 1024 * 1024) throw new GenerationRequestError('Choose photos under 30 MB each.')
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new GenerationRequestError('This photo cannot be opened. Try a JPEG or a new camera photo.'))
      image.src = url
    })
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 80_000_000) throw new GenerationRequestError('This photo is too large to prepare safely.')
    const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new GenerationRequestError('This device could not prepare the photo.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const data = canvas.toDataURL('image/jpeg', 0.92).split(',')[1]
    canvas.width = 1
    canvas.height = 1
    if (!data) throw new GenerationRequestError('This photo could not be prepared.')
    return { type: 'image/jpeg', data }
  } finally { URL.revokeObjectURL(url) }
}

export async function startGeneration(options: RequestOptions & {
  id: string; files: File[]; prompt: string; consent: true; azimuths?: number[]; horizontalFovs?: number[]
  prepareReference?: typeof prepareGenerationReference
}): Promise<GenerationJob> {
  if (!JOB_ID.test(options.id)) throw new GenerationRequestError('Save a draft before generating.')
  if (options.consent !== true) throw new GenerationRequestError('Confirm AI reconstruction and transfer to your computer first.')
  if (options.files.length < 1 || options.files.length > 4) throw new GenerationRequestError('Choose one to four photos.')
  if (options.horizontalFovs && (options.horizontalFovs.length !== options.files.length || options.horizontalFovs.some((angle) => !Number.isFinite(angle) || angle < 25 || angle > 110))) throw new GenerationRequestError('The reference camera angles are invalid. Prepare these photos again.')
  const photos = []
  for (const file of options.files) {
    checkAbort(options.signal)
    photos.push(await (options.prepareReference ?? prepareGenerationReference)(file))
  }
  checkAbort(options.signal)
  return request('/jobs', async (response) => readJob(await response.json(), options.id), options, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bubble-Generation': '1' },
    body: JSON.stringify({ id: options.id, photos, prompt: options.prompt, consent: true, azimuths: options.azimuths ?? options.files.map((_, index) => index * 90), horizontalFovs: options.horizontalFovs }),
  }, 180_000)
}
export async function downloadGeneration(id: string, options: RequestOptions = {}): Promise<{ file: File; width: number; height: number }> {
  if (!JOB_ID.test(id)) throw new GenerationRequestError('This draft has an invalid job ID.')
  const blob = await request(`/jobs/${id}/panorama`, (response) => response.blob(), options, {}, 90_000)
  checkAbort(options.signal)
  const dimensions = await validateGeneratedPanorama(blob)
  checkAbort(options.signal)
  const file = new File([blob], 'ai-reconstruction.png', { type: blob.type })
  return { file, ...dimensions }
}
