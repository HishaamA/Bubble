import type { CapsuleImageSource } from '../../capsules/types'
import type { UnlockedCapsulePhoto } from '../capsuleJournalArchive'
import type {
  JournalPhoto,
  JournalPhotoImportProgress,
  JournalPhotoImportResult,
} from '../journalPhotoTypes'

export const FAMILY_PERSON_ID = 'family'
export const FACE_MODEL_REVISION = 'human-3.3.6-faceres-v1'
export const FACE_SCAN_REVISION = 'human-3.3.6-faceres-rotation-equalized-v2'

export type TimelinePerson = {
  id: string
  name: string
  createdAt: string
}

export type TimelineDatePrecision = 'day' | 'year'

export type TimelineDateOverride = {
  value: string
  precision: TimelineDatePrecision
}

export type TimelinePhotoAssignment = {
  photoKey: string
  personId: string
  faceId?: string
  source: 'manual' | 'face-suggestion'
  confirmedAt: string
}

export type DismissedFaceSuggestion = {
  photoKey: string
  personId: string
  faceId?: string
  dismissedAt: string
}

export type NormalizedFaceBox = [
  x: number,
  y: number,
  width: number,
  height: number,
]

export type StoredFaceDetection = {
  id: string
  embedding: number[]
  box: NormalizedFaceBox
  detectorScore: number
  descriptorScore: number
  quality: number
}

export type StoredPhotoFaceScan = {
  scannedAt: string
  faces: StoredFaceDetection[]
}

export type FaceReference = {
  id: string
  embedding: number[]
  source: 'enrollment' | 'manual-photo'
  createdAt: string
  quality?: number
  photoKey?: string
  faceId?: string
}

export type FaceProfile = {
  references: FaceReference[]
}

export type PeopleTimelinePhoto = {
  key: string
  id: string
  kind: 'capsule-photo' | 'journal-photo'
  source: CapsuleImageSource
  scanSource: CapsuleImageSource
  capturedAt: string
  caption: string
  contributorName: string
  capsuleId: string
  memoryId: string
  canScanFaces: boolean
  legacyKeys?: string[]
}

export type PeopleTimelineState = {
  version: 4
  faceModelRevision: typeof FACE_MODEL_REVISION
  faceScanRevision: typeof FACE_SCAN_REVISION
  people: TimelinePerson[]
  assignments: TimelinePhotoAssignment[]
  dateOverrides: Record<string, TimelineDateOverride>
  faceScans: Record<string, StoredPhotoFaceScan>
  faceProfiles: Record<string, FaceProfile>
  dismissedSuggestions: DismissedFaceSuggestion[]
}

export type FaceSuggestion = {
  photoKey: string
  faceId: string
  personId: string
  confidence: number
}

export type PeopleTimelineProps = {
  photos: readonly UnlockedCapsulePhoto[]
  journalPhotos?: readonly JournalPhoto[]
  cacheNamespace: string
  className?: string
  initialPersonId?: string
  focusMemoryId?: string
  onUploadPhotos?: (
    files: readonly File[],
  ) => Promise<JournalPhotoImportResult>
  photoImportProgress?: JournalPhotoImportProgress
}
