export type PersonScrapbookProfile = {
  birthday: string
  relation: string
  favoriteThings: string
  notes: string
}

type StoredPersonScrapbookProfile = PersonScrapbookProfile & {
  version: 1
}

const STORAGE_PREFIX = 'bubble:person-scrapbook:v1:'
const MAX_RELATION_LENGTH = 60
const MAX_FAVORITE_THINGS_LENGTH = 240
const MAX_NOTES_LENGTH = 1_200

export function emptyPersonScrapbookProfile(): PersonScrapbookProfile {
  return {
    birthday: '',
    relation: '',
    favoriteThings: '',
    notes: '',
  }
}

export function personScrapbookStorageKey(
  cacheNamespace: string,
  personId: string,
) {
  return `${STORAGE_PREFIX}${encodeURIComponent(cacheNamespace || 'local')}:${encodeURIComponent(personId)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, maximumLength: number) {
  return typeof value === 'string' ? value.slice(0, maximumLength) : ''
}

function validBirthday(value: unknown) {
  if (typeof value !== 'string') return ''
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return ''

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? value
    : ''
}

function normalizeProfile(value: unknown): PersonScrapbookProfile {
  if (!isRecord(value)) return emptyPersonScrapbookProfile()
  return {
    birthday: validBirthday(value.birthday),
    relation: boundedString(value.relation, MAX_RELATION_LENGTH),
    favoriteThings: boundedString(
      value.favoriteThings,
      MAX_FAVORITE_THINGS_LENGTH,
    ),
    notes: boundedString(value.notes, MAX_NOTES_LENGTH),
  }
}

export function loadPersonScrapbookProfile(
  cacheNamespace: string,
  personId: string,
): PersonScrapbookProfile {
  if (typeof window === 'undefined') return emptyPersonScrapbookProfile()

  try {
    const stored = window.localStorage.getItem(
      personScrapbookStorageKey(cacheNamespace, personId),
    )
    if (!stored) return emptyPersonScrapbookProfile()
    const value = JSON.parse(stored) as unknown
    if (!isRecord(value) || value.version !== 1) {
      return emptyPersonScrapbookProfile()
    }
    return normalizeProfile(value)
  } catch {
    return emptyPersonScrapbookProfile()
  }
}

export function savePersonScrapbookProfile(
  cacheNamespace: string,
  personId: string,
  profile: PersonScrapbookProfile,
) {
  if (typeof window === 'undefined') return false

  const stored: StoredPersonScrapbookProfile = {
    version: 1,
    ...normalizeProfile(profile),
  }
  try {
    window.localStorage.setItem(
      personScrapbookStorageKey(cacheNamespace, personId),
      JSON.stringify(stored),
    )
    return true
  } catch {
    return false
  }
}

export function removePersonScrapbookProfile(
  cacheNamespace: string,
  personId: string,
) {
  if (typeof window === 'undefined') return false

  try {
    window.localStorage.removeItem(
      personScrapbookStorageKey(cacheNamespace, personId),
    )
    return true
  } catch {
    return false
  }
}
