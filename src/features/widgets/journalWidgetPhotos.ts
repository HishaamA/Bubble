import type { FamilyCapsule } from '../capsules/types'
import { JOURNAL_LIBRARY_ID, type JournalPhoto } from '../journal/journalPhotoTypes'
import { canonicalCapsulePhotos } from '../journal/canonicalCapsulePhotos'

export const journalWidgetRotationMs = 60 * 60 * 1_000

export type JournalWidgetPhoto = {
  collectionId: string
  photo: JournalPhoto
}

/**
 * The widget uses the same two sources as Journal's All timeline. Never read
 * unsynced/local-only media or reveal a Capsule before its server unlock time.
 * A stable shuffle, advanced hourly, lets older photos surface as often as new
 * ones without reshuffling every time settings or checklist state changes.
 */
export function selectJournalWidgetPhotos(
  journalPhotos: readonly JournalPhoto[],
  capsules: readonly FamilyCapsule[],
  now: Date,
): JournalWidgetPhoto[] {
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) return []
  const candidates: JournalWidgetPhoto[] = [
    ...journalPhotos.map((photo) => ({ collectionId: JOURNAL_LIBRARY_ID, photo })),
    ...canonicalCapsulePhotos(capsules.filter((capsule) => (
      capsule.familySynced === true
      && capsule.id.trim().length > 0
      && Number.isFinite(Date.parse(capsule.closesAt))
      && Date.parse(capsule.opensAt) <= nowMs
    )).flatMap((capsule) => capsule.photos.filter((photo) => (
      photo.syncStatus === 'synced'
      && Number.isFinite(Date.parse(photo.capturedAt))
    )).map((photo) => ({ ...photo, capsuleId: capsule.id, syncStatus: 'synced' as const })))).map((photo) => ({
      collectionId: photo.capsuleId,
      photo,
    })),
  ]
  const unique = new Map<string, JournalWidgetPhoto>()
  for (const candidate of candidates) {
    if (!candidate.collectionId.trim() || !candidate.photo.id.trim()
      || candidate.photo.syncStatus !== 'synced'
      || candidate.photo.origin === 'device-gallery'
      || !Number.isFinite(Date.parse(candidate.photo.capturedAt))) continue
    unique.set(identity(candidate), candidate)
  }
  const shuffled = [...unique.values()].sort((left, right) => (
    shuffleRank(identity(left)) - shuffleRank(identity(right))
    || identity(left).localeCompare(identity(right))
  ))
  if (shuffled.length < 2) return shuffled
  const offset = Math.floor(nowMs / journalWidgetRotationMs) % shuffled.length
  return [...shuffled.slice(offset), ...shuffled.slice(0, offset)]
}

/** IDs, not signed media URLs, select the exact photo in the ordinary timeline. */
export function journalWidgetPhotoRoute({ collectionId, photo }: JournalWidgetPhoto) {
  return `/journal?photo=${encodeURIComponent(photo.id)}&collection=${encodeURIComponent(collectionId)}&source=widget`
}

/** Matches Journal's content-stable namespace even when Capsule membership changes. */
export function journalWidgetPhotoKey({ collectionId, photo }: JournalWidgetPhoto) {
  return collectionId === JOURNAL_LIBRARY_ID ? `journal-photo:${photo.id}` : `photo:${photo.id}`
}

function identity(memory: JournalWidgetPhoto) {
  return journalWidgetPhotoKey(memory)
}

function shuffleRank(value: string) {
  let hash = 2166136261
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  // Avalanche sequential UUID/fixture suffixes instead of arranging by date.
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  return hash >>> 0
}
