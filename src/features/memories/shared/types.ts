export type MomentSource = 'daily' | 'manual'

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
}

export type PanoramaMoment = StoredPanoramaMoment & {
  /** A short-lived local preview URL. Null when object URLs are unavailable. */
  objectUrl: string | null
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
}

export interface MomentStore {
  list(): Promise<StoredPanoramaMoment[]>
  save(moment: StoredPanoramaMoment): Promise<void>
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
