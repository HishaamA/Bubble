import type { CapsuleImageSource } from '../capsules/types'

export const JOURNAL_LIBRARY_ID = 'family-photo-library'

export type JournalPhoto = {
  id: string
  image: CapsuleImageSource
  thumbnail: CapsuleImageSource
  width: number
  height: number
  thumbnailWidth?: number
  thumbnailHeight?: number
  caption: string
  capturedAt: string
  contributorName: string
  ownedByCurrentUser: boolean
  syncStatus: 'pending' | 'synced'
}

export type JournalPhotoStore = {
  list: () => Promise<JournalPhoto[]>
  save: (photo: JournalPhoto) => Promise<void>
  remove: (photoId: string) => Promise<void>
}

export type JournalPhotoImportProgress = {
  importing: boolean
  completed: number
  total: number
}

export type JournalPhotoImportResult = {
  added: number
  failed: number
}
