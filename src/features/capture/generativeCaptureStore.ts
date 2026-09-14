import type { StoredPanoramaAnnotation } from '../memories/shared'
import type { AiPanoramaProvenance } from '../../services/media/panoramaProvenance'
import type { ReferenceFieldOfViewEstimate } from '../../services/media/referenceFieldOfView'

export type GenerationDraftJob = {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'submission-unknown'
  stage: string
  error?: string
  width?: number
  height?: number
}

export type GenerationReferencePhoto = {
  id: string
  name: string
  original: Blob
  image: Blob
  thumbnail: Blob
  width: number
  height: number
  origin: 'camera' | 'library'
  azimuth: number
  /** A local estimate from the upright photo, not calibrated camera geometry. */
  fieldOfView?: ReferenceFieldOfViewEstimate
}

export type GenerativeCaptureDraft = {
  version: 1
  id: string
  ownerKey: string
  createdAt: string
  updatedAt: string
  photos: GenerationReferencePhoto[]
  prompt: string
  caption: string
  annotations: StoredPanoramaAnnotation[]
  job?: GenerationDraftJob
  generationModel?: string
  result?: {
    file: Blob
    width: number
    height: number
    provenance: AiPanoramaProvenance
  }
  savedMomentId?: string
}

export interface GenerativeCaptureStore {
  list(): Promise<GenerativeCaptureDraft[]>
  save(draft: GenerativeCaptureDraft): Promise<void>
  remove(id: string): Promise<void>
}

export function generativeCaptureDatabaseName(ownerKey: string) {
  if (!ownerKey.trim()) throw new Error('Sign in to keep your scene photos with your account.')
  return `bubble-generative-capture:${encodeURIComponent(ownerKey)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPhoto(value: unknown): value is GenerationReferencePhoto {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
    && value.original instanceof Blob && value.original.size > 0 && value.original.size <= 25 * 1024 * 1024
    && value.image instanceof Blob && value.image.size > 0 && value.thumbnail instanceof Blob
    && Number.isSafeInteger(value.width) && Number(value.width) > 0 && Number(value.width) <= 2048
    && Number.isSafeInteger(value.height) && Number(value.height) > 0 && Number(value.height) <= 2048
    && (value.origin === 'camera' || value.origin === 'library')
    && [0, 90, 180, 270].includes(Number(value.azimuth)) && typeof value.azimuth === 'number'
}

/** A bad optional estimate must not hide otherwise recoverable photos or results. */
function copyFieldOfView(value: unknown): ReferenceFieldOfViewEstimate | undefined {
  if (!isRecord(value) || typeof value.horizontalFovDegrees !== 'number'
    || !Number.isFinite(value.horizontalFovDegrees) || value.horizontalFovDegrees < 25 || value.horizontalFovDegrees > 110
    || (value.source !== 'exif-35mm-equivalent' && value.source !== 'diagonal-fallback') || value.estimated !== true) return undefined
  return { horizontalFovDegrees: value.horizontalFovDegrees, source: value.source, estimated: true }
}

function isAnnotation(value: unknown): value is StoredPanoramaAnnotation {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 160
    && (value.kind === 'text' || value.kind === 'voice')
    && typeof value.pitch === 'number' && Number.isFinite(value.pitch) && Math.abs(value.pitch) <= 90
    && typeof value.yaw === 'number' && Number.isFinite(value.yaw) && Math.abs(value.yaw) <= 180
    && typeof value.message === 'string' && value.message.length <= 180
    && (value.audioBlob === undefined || value.audioBlob instanceof Blob)
    && (value.audioMimeType === undefined || typeof value.audioMimeType === 'string')
    && (value.durationMs === undefined || (typeof value.durationMs === 'number' && Number.isInteger(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 60_000))
}

/** Saved drafts are untrusted input; never expose another account or temporary URLs. */
export function parseGenerativeCaptureDraft(value: unknown, ownerKey: string): GenerativeCaptureDraft | null {
  if (!isRecord(value) || value.version !== 1 || value.ownerKey !== ownerKey
    || typeof value.id !== 'string' || !value.id || value.id.length > 160
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || !Array.isArray(value.photos) || value.photos.length > 4 || !value.photos.every(isPhoto)
    || typeof value.prompt !== 'string' || value.prompt.length > 1200
    || typeof value.caption !== 'string' || value.caption.length > 240
    || !Array.isArray(value.annotations) || value.annotations.length > 8 || !value.annotations.every(isAnnotation)) return null
  if (value.job !== undefined && (!isRecord(value.job) || typeof value.job.id !== 'string'
    || !value.job.id || typeof value.job.stage !== 'string'
    || !['queued', 'running', 'completed', 'failed', 'submission-unknown'].includes(String(value.job.status)))) return null
  if (value.result !== undefined) {
    const result = value.result
    if (!isRecord(result) || !(result.file instanceof Blob) || result.file.size === 0 || result.file.size > 36 * 1024 * 1024 || !result.file.type.startsWith('image/')
      || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height)
      || Number(result.height) < 512 || Number(result.width) > 8192 || result.width !== Number(result.height) * 2
      || !isRecord(result.provenance) || result.provenance.kind !== 'ai-reconstruction'
      || result.provenance.provider !== 'local' || typeof result.provenance.model !== 'string' || !result.provenance.model.trim()
      || typeof result.provenance.generatedAt !== 'string' || !Number.isFinite(Date.parse(result.provenance.generatedAt))
      || !Number.isInteger(result.provenance.referenceCount) || Number(result.provenance.referenceCount) < 1
      || Number(result.provenance.referenceCount) > 4) return null
  }
  if (value.savedMomentId !== undefined && typeof value.savedMomentId !== 'string') return null
  if (value.generationModel !== undefined && typeof value.generationModel !== 'string') return null
  const draft = value as GenerativeCaptureDraft
  return { ...draft, photos: draft.photos.map((photo) => ({ ...photo, fieldOfView: copyFieldOfView(photo.fieldOfView) })),
    annotations: draft.annotations.map((annotation) => ({ ...annotation })),
    job: draft.job ? { ...draft.job } : undefined,
    result: draft.result ? { ...draft.result, provenance: { ...draft.result.provenance } } : undefined }
}

function newestFirst(a: GenerativeCaptureDraft, b: GenerativeCaptureDraft) {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
}

/** Test-only/explicit ephemeral store; the default store never silently falls back to memory. */
export function createMemoryGenerativeCaptureStore(ownerKey: string): GenerativeCaptureStore {
  generativeCaptureDatabaseName(ownerKey)
  const records = new Map<string, GenerativeCaptureDraft>()
  return {
    async list() { return [...records.values()].map((draft) => parseGenerativeCaptureDraft(draft, ownerKey)!).sort(newestFirst) },
    async save(draft) {
      const parsed = parseGenerativeCaptureDraft(draft, ownerKey)
      if (!parsed) throw new Error('This scene draft is invalid or belongs to another account.')
      records.set(parsed.id, parsed)
    },
    async remove(id) { records.delete(id) },
  }
}

export function createGenerativeCaptureStore(ownerKey: string, indexedDb?: IDBFactory): GenerativeCaptureStore {
  const name = generativeCaptureDatabaseName(ownerKey)
  const factory = indexedDb ?? globalThis.indexedDB
  function open() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      if (!factory) { reject(new Error('Durable photo storage is unavailable. Enable local storage before creating a scene.')); return }
      const request = factory.open(name, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts', { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Could not open scene drafts.'))
      request.onblocked = () => reject(new Error('Close the other Bubble window, then reopen your scene drafts.'))
    })
  }
  async function write(action: (store: IDBObjectStore) => void) {
    const database = await open()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('drafts', 'readwrite')
        action(transaction.objectStore('drafts'))
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('Could not save this scene draft. Check free space.'))
        transaction.onabort = () => reject(transaction.error ?? new Error('Saving this scene draft was interrupted.'))
      })
    } finally { database.close() }
  }
  return {
    async list() {
      const database = await open()
      try {
        return await new Promise<GenerativeCaptureDraft[]>((resolve, reject) => {
          const transaction = database.transaction('drafts', 'readonly')
          const request = transaction.objectStore('drafts').getAll()
          request.onsuccess = () => resolve(request.result.map((value: unknown) => parseGenerativeCaptureDraft(value, ownerKey))
            .filter((draft: GenerativeCaptureDraft | null): draft is GenerativeCaptureDraft => draft !== null).sort(newestFirst))
          request.onerror = () => reject(request.error ?? new Error('Could not read scene drafts.'))
          transaction.onabort = () => reject(transaction.error ?? new Error('Reading scene drafts was interrupted.'))
        })
      } finally { database.close() }
    },
    async save(draft) {
      const parsed = parseGenerativeCaptureDraft(draft, ownerKey)
      if (!parsed) throw new Error('This scene draft is invalid or belongs to another account.')
      await write((store) => store.put(parsed))
    },
    async remove(id) { await write((store) => store.delete(id)) },
  }
}
