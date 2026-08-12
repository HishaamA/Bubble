export type CapsuleKind = 'weekly' | 'special'

export type CapsuleImageSource = Blob | string

export type CapsulePhoto = {
  id: string
  capsuleId: string
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
  syncStatus?: 'pending' | 'synced'
}

export type FamilyCapsule = {
  id: string
  kind: CapsuleKind
  title: string
  createdAt: string
  closesAt: string
  opensAt: string
  weekStart?: string
  createdByName: string
  photos: CapsulePhoto[]
  totalPhotoCount?: number
  familySynced?: boolean
}

export type ProcessedCapsulePhoto = {
  image: Blob
  thumbnail: Blob
  width: number
  height: number
  thumbnailWidth: number
  thumbnailHeight: number
}

export type CapsuleStore = {
  list: () => Promise<FamilyCapsule[]>
  save: (capsule: FamilyCapsule) => Promise<void>
  remove: (capsuleId: string) => Promise<void>
}
