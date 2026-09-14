import type { PhoneGalleryAsset } from './gallery/phoneGallery'
import type { JournalPhoto } from './journalPhotoTypes'
import type { PeopleTimelineState } from './people/types'

export const GALLERY_TIMELINE_PREFIX = 'journal-photo:device-gallery:'

/** References only: never call the upload/import pipeline for library photos. */
export function phoneGalleryJournalPhotos(assets: readonly PhoneGalleryAsset[]): JournalPhoto[] {
  return [...new Map(assets.map((asset) => [asset.id, asset])).values()].map((asset) => ({
    id: `${asset.id}:${encodeURIComponent(asset.modifiedAt ?? '')}`,
    origin: 'device-gallery',
    image: asset.source,
    thumbnail: asset.source,
    width: asset.width,
    height: asset.height,
    capturedAt: asset.capturedAt,
    caption: 'A photo from your phone',
    contributorName: 'Your phone gallery',
    ownedByCurrentUser: false,
    syncStatus: 'local',
  }))
}

/** Forget only linked-photo metadata; preserve uploads, people and enrollment portraits. */
export function prunePhoneGalleryMatches(state: PeopleTimelineState, allowedKeys: ReadonlySet<string>) {
  const keep = (key: string) => !key.startsWith(GALLERY_TIMELINE_PREFIX) || allowedKeys.has(key)
  const keys = [
    ...Object.keys(state.faceScans), ...Object.keys(state.dateOverrides),
    ...state.assignments.map(({ photoKey }) => photoKey),
    ...state.dismissedSuggestions.map(({ photoKey }) => photoKey),
    ...Object.values(state.faceProfiles).flatMap(({ references }) => references.flatMap(
      (reference) => reference.photoKey ? [reference.photoKey] : [])),
  ]
  if (keys.every(keep)) return state
  return {
    ...state,
    faceScans: Object.fromEntries(Object.entries(state.faceScans).filter(([key]) => keep(key))),
    dateOverrides: Object.fromEntries(Object.entries(state.dateOverrides).filter(([key]) => keep(key))),
    assignments: state.assignments.filter(({ photoKey }) => keep(photoKey)),
    dismissedSuggestions: state.dismissedSuggestions.filter(({ photoKey }) => keep(photoKey)),
    faceProfiles: Object.fromEntries(Object.entries(state.faceProfiles).map(([id, profile]) => [id, {
      ...profile, references: profile.references.filter((ref) => !ref.photoKey || keep(ref.photoKey)),
    }])),
  }
}
