import type { StoredPanoramaAnnotation } from '../memories/shared'
import type { AiPanoramaProvenance } from '../../services/media/panoramaProvenance'

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
  provenance?: AiPanoramaProvenance
  captureSessionId?: string
}
