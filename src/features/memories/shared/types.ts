export type MomentSource = 'daily' | 'manual'

export type PanoramaAnnotationKind = 'text' | 'voice'

export type StoredPanoramaAnnotation = {
  id: string
  kind: PanoramaAnnotationKind
  pitch: number
  yaw: number
  message: string
  audioBlob?: Blob
  audioMimeType?: string
  durationMs?: number
}

export type PanoramaAnnotation = StoredPanoramaAnnotation & {
  /** A short-lived local playback URL for a saved voice note. */
  audioUrl: string | null
}

export type StoredPanoramaMoment = {
  id: string
  blob: Blob
  label: string
  caption: string
  createdAt: string
  width: number
  height: number
  source: MomentSource
  uploaderDisplayName: string
  /**
   * Set only when the signed-in account is known to be the uploader. The
   * delete UI must never infer ownership from a display name alone.
   */
  ownedByCurrentUser?: boolean
  /** True when this record mirrors a row in the family backend. */
  familySynced?: boolean
  /** Optional for backward compatibility with moments saved before points existed. */
  annotations?: StoredPanoramaAnnotation[]
}

export type PanoramaMoment = Omit<StoredPanoramaMoment, 'annotations'> & {
  /** A short-lived local preview URL. Null when object URLs are unavailable. */
  objectUrl: string | null
  annotations?: PanoramaAnnotation[]
}

export type SavePanoramaMomentInput = {
  id?: string
  blob: Blob
  label?: string
  caption?: string
  createdAt?: string | Date
  width: number
  height: number
  source: MomentSource
  uploaderDisplayName: string
  ownedByCurrentUser?: boolean
  familySynced?: boolean
  annotations?: StoredPanoramaAnnotation[]
}

export interface MomentStore {
  list(): Promise<StoredPanoramaMoment[]>
  save(moment: StoredPanoramaMoment): Promise<void>
  remove(ids: readonly string[]): Promise<void>
}

export interface MomentObjectUrlManager {
  create(blob: Blob): string | null
  revoke(url: string): void
}

export interface MomentChangeNotifier {
  subscribe(listener: () => void): () => void
  publish(): void
  close(): void
}
