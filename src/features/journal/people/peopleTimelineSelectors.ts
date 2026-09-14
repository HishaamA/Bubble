import { sortTimelinePhotos } from './peopleTimelineHelpers'
import {
  ALL_PHOTOS_PERSON_ID,
  FAMILY_PERSON_ID,
  type FaceSuggestion,
  type TimelinePerson,
  type PeopleTimelinePhoto,
  type PeopleTimelineState,
} from './types'

export const FACE_REVIEW_PERSON_ID = 'review-face-matches'

export type FaceReviewPreview = {
  match: FaceSuggestion
  photo: PeopleTimelinePhoto
  person: TimelinePerson
  faceCenter: [x: number, y: number]
  faceScale: number
}

export type PeoplePhotoAlbum = {
  person: TimelinePerson
  preview: PeopleTimelinePhoto
  photoCount: number
}

export type PeopleByPhoto = ReadonlyMap<string, ReadonlySet<string>>

/** Identifies one review decision, without conflating other faces or people. */
export function faceReviewKey(suggestion: FaceSuggestion) {
  return `${suggestion.photoKey}\u0000${suggestion.faceId}\u0000${suggestion.personId}`
}

/** Builds up to three distinct-photo previews in the review queue's order. */
export function selectFaceReviewPreviews(
  matches: readonly FaceSuggestion[],
  photos: readonly PeopleTimelinePhoto[],
  people: readonly TimelinePerson[],
  faceScans: PeopleTimelineState['faceScans'],
): FaceReviewPreview[] {
  const photosByKey = new Map(photos.map((photo) => [photo.key, photo]))
  const peopleById = new Map(people.map((person) => [person.id, person]))
  const previews: FaceReviewPreview[] = []
  const usedPhotos = new Set<string>()
  for (const match of matches) {
    if (usedPhotos.has(match.photoKey)) continue
    const photo = photosByKey.get(match.photoKey)
    const person = peopleById.get(match.personId)
    const face = faceScans[match.photoKey]?.faces.find(({ id }) => id === match.faceId)
    if (!photo || !person || !face) continue
    usedPhotos.add(match.photoKey)
    previews.push({
      match,
      photo,
      person,
      faceCenter: [face.box[0] + face.box[2] / 2, face.box[1] + face.box[3] / 2],
      faceScale: Math.min(2.8, Math.max(1.25, 0.7 / Math.max(face.box[2], face.box[3]))),
    })
    if (previews.length === 3) break
  }
  return previews
}

/** Resolves manual decisions and accepted recognition once per photo. */
export function selectEffectivePeopleByPhoto(
  state: PeopleTimelineState,
  photos: readonly PeopleTimelinePhoto[],
  automaticMatches: readonly FaceSuggestion[],
): PeopleByPhoto {
  // Index each decision once rather than walking every match for every photo
  // after each gallery batch. Preserve the original people ordering and policy.
  const peopleIds = new Set(state.people.map(({ id }) => id))
  const result = new Map(photos.map(({ key }) => [key, new Set<string>()]))
  const dismissed = new Set(state.dismissedSuggestions.map(({ photoKey, personId, faceId }) =>
    `${photoKey}\u0000${personId}\u0000${faceId ?? '*'}`))
  const dismissedPairs = new Set(state.dismissedSuggestions.map(({ photoKey, personId }) => `${photoKey}\u0000${personId}`))
  for (const { photoKey, personId, source } of state.assignments) {
    // Older builds persisted inferred links. They are not a user decision and
    // must qualify again through the current automatic-matching policy below.
    if (source === 'manual' && peopleIds.has(personId)) result.get(photoKey)?.add(personId)
  }
  for (const { photoKey, personId, faceId } of automaticMatches) {
    const pair = `${photoKey}\u0000${personId}`
    if (!peopleIds.has(personId) || dismissed.has(`${pair}\u0000*`) ||
      (faceId ? dismissed.has(`${pair}\u0000${faceId}`) : dismissedPairs.has(pair))) continue
    result.get(photoKey)?.add(personId)
  }
  return new Map([...result].map(([key, selected]) =>
    [key, new Set([...peopleIds].filter((id) => selected.has(id)))]))
}

/** Enrollment, not the mere presence of a name, enables automatic grouping. */
export function selectEnrolledPersonIds(profiles: PeopleTimelineState['faceProfiles']) {
  return new Set(Object.entries(profiles)
    .filter(([, profile]) => profile.references.length > 0)
    .map(([personId]) => personId))
}

/** Shares one photo index between the people rail and album tiles. */
export function selectPeoplePhotoAlbums(
  people: readonly TimelinePerson[],
  photos: readonly PeopleTimelinePhoto[],
  effectivePeople: PeopleByPhoto,
) {
  const albumsByPerson = new Map<string, PeoplePhotoAlbum>()
  const peopleById = new Map(people.map((person) => [person.id, person]))
  for (const photo of photos) {
    for (const personId of effectivePeople.get(photo.key) ?? []) {
      const person = peopleById.get(personId)
      if (!person) continue
      const album = albumsByPerson.get(personId)
      if (album) album.photoCount += 1
      else albumsByPerson.set(personId, { person, preview: photo, photoCount: 1 })
    }
  }
  // Preserve profile order and the first source photo; timeline date overrides
  // deliberately affect the slider, not the existing album cover choice.
  const albums = people.flatMap(({ id }) => {
    const album = albumsByPerson.get(id)
    return album ? [album] : []
  })
  const previews = new Map(albums.map(({ person, preview }) => [person.id, preview]))
  return { albums, previews }
}

/** Any two distinct family members qualify; accepted manual tags need no enrollment. */
export function selectFamilyPhotoKeys(
  photos: readonly PeopleTimelinePhoto[],
  effectivePeople: PeopleByPhoto,
  familyPersonIds: ReadonlySet<string>,
) {
  return new Set(photos.filter((photo) => {
    let familyCount = 0
    for (const personId of effectivePeople.get(photo.key) ?? []) {
      if (familyPersonIds.has(personId)) familyCount += 1
      if (familyCount >= 2) return true
    }
    return false
  }).map(({ key }) => key))
}

type TimelineSelection = {
  selectedPersonId: string
  photos: readonly PeopleTimelinePhoto[]
  reviewMatches: readonly FaceSuggestion[]
  effectivePeople: PeopleByPhoto
  familyPhotoKeys: ReadonlySet<string>
  dateOverrides: PeopleTimelineState['dateOverrides']
}

/** Applies one filter, then the same corrected chronological order to each view. */
export function selectVisibleTimelinePhotos({
  selectedPersonId,
  photos,
  reviewMatches,
  effectivePeople,
  familyPhotoKeys,
  dateOverrides,
}: TimelineSelection) {
  const reviewPhotoKeys = selectedPersonId === FACE_REVIEW_PERSON_ID
    ? new Set(reviewMatches.map(({ photoKey }) => photoKey))
    : null
  const relevantPhotos = selectedPersonId === ALL_PHOTOS_PERSON_ID
    ? photos
    : selectedPersonId === FACE_REVIEW_PERSON_ID
      ? photos.filter(({ key }) => reviewPhotoKeys?.has(key))
      : selectedPersonId === FAMILY_PERSON_ID
        ? photos.filter(({ key }) => familyPhotoKeys.has(key))
        : photos.filter(({ key }) => effectivePeople.get(key)?.has(selectedPersonId))
  return sortTimelinePhotos(relevantPhotos, dateOverrides)
}
