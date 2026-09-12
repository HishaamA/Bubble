import type { StoredPanoramaAnnotation } from '../memories/shared'

export type CaptureSource = 'daily' | 'manual'

export type Capture360Submission = {
  id: string
  file: File
  caption: string
  source: CaptureSource
  width: number
  height: number
  createdAt: Date
  annotations: StoredPanoramaAnnotation[]
}
