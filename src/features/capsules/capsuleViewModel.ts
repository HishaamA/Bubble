import { addLocalDays } from './capsuleDates'
import type { CapsulePhoto, FamilyCapsule } from './types'

const CAPSULE_FEATURED_DURATION_MS = 3 * 24 * 60 * 60 * 1000
const CAPSULE_PHOTO_PREVIEW_DURATION_MS = 4 * 24 * 60 * 60 * 1000

/** A brief reveal window; re-rendering a saved recap must not reset its age. */
export function mayPreviewCapsulePhotos(capsule: Pick<FamilyCapsule, 'opensAt'>, now: Date) {
  const age = now.getTime() - new Date(capsule.opensAt).getTime()
  return Number.isFinite(age) && age >= 0 && age <= CAPSULE_PHOTO_PREVIEW_DURATION_MS
}

/** Display grouping only: media authorization still comes from the family API. */
export function isPastCapsule(capsule: Pick<FamilyCapsule, 'opensAt'>, now: Date) {
  const openedAt = new Date(capsule.opensAt).getTime()
  return Number.isFinite(openedAt) && now.getTime() - openedAt > CAPSULE_FEATURED_DURATION_MS
}

/** Keeps both kinds in their current section for three full days after reveal. */
export function partitionCapsulesByAge(capsules: readonly FamilyCapsule[], now: Date) {
  const active: FamilyCapsule[] = []
  const past: FamilyCapsule[] = []
  for (const capsule of capsules) {
    (isPastCapsule(capsule, now) ? past : active).push(capsule)
  }
  return { active, past }
}

/** Formats a weekly Capsule as the inclusive six-night collection range. */
export function formatWeekRange(capsule: FamilyCapsule) {
  const start = capsule.weekStart
    ? new Date(`${capsule.weekStart}T12:00:00`)
    : new Date(capsule.createdAt)
  const end = addLocalDays(start, 6)
  const startLabel = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(start)
  const endLabel = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(end)
  return `${startLabel}–${endLabel}`
}

/** Selects the calendar range for weekly Capsules and the authored special title. */
export function capsuleDisplayTitle(capsule: FamilyCapsule) {
  return capsule.kind === 'weekly' ? formatWeekRange(capsule) : capsule.title
}

/** Includes remotely counted photos that are not currently cached on this device. */
export function capsuleHasPhotos(capsule: FamilyCapsule) {
  return Math.max(capsule.totalPhotoCount ?? 0, capsule.photos.length) > 0
}

/** Keeps only media sources that can be decoded by a recap renderer right now. */
export function capsuleRecapPhotos(photos: CapsulePhoto[]) {
  return photos.filter(({ image }) => {
    if (typeof image !== 'string') return image.size > 0

    const source = image.trim()
    // Object URLs belong to one WebView session. An older URL can still be in
    // the Capsule metadata after a legacy app restart, but it cannot be opened
    // or rendered into a recap. Pending IndexedDB Blobs, on the other hand,
    // are fully usable on this phone even before family sync succeeds.
    return source.length > 0 && !source.startsWith('blob:')
  })
}
