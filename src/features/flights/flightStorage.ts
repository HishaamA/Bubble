import { looksLikeTicketNumber, normalizeFlightNumber } from './flightValidation'
import type {
  FlightAirport,
  FlightStatusSnapshot,
  TrackedFlight,
} from './types'

const storagePrefix = 'kinsphere-family-flights:v1:'
const activeSubjectStorageKey = 'kinsphere-family-flights:active-subject:v1'
const pendingCreateStoragePrefix = 'kinsphere-family-flights:pending-create:v1:'
const memoryStorage = new Map<string, TrackedFlight[]>()
const pendingCreateMemoryStorage = new Map<string, PendingFlightCreateIntent[]>()
const pendingCreateLifetimeMs = 7 * 24 * 60 * 60 * 1000

export type PendingFlightCreateIdentity = {
  travelerName: string
  flightNumber: string
  travelDate: string
}

type PendingFlightCreateIntent = PendingFlightCreateIdentity & {
  id: string
  createdAt: number
}

/** Builds the cache namespace shared by one account and family membership. */
export function familyFlightStorageSubject(
  userId: string | null | undefined,
  familyId: string | null | undefined,
) {
  const account = userId?.trim() || 'signed-out'
  const family = familyId?.trim() || 'no-family'
  return `${account}:family:${family}`
}

/** Encodes a subject into its tracked-flight storage key. */
export function flightStorageKey(accountId: string) {
  return `${storagePrefix}${encodeURIComponent(accountId.trim() || 'signed-out')}`
}

/** Reads the subject whose notifications currently belong to this device. */
export function readActiveFlightStorageSubject() {
  try {
    const subject = localStorage.getItem(activeSubjectStorageKey)?.trim()
    return subject || null
  } catch {
    return null
  }
}

/** Records the subject that owns this device's active flight notifications. */
export function writeActiveFlightStorageSubject(subject: string) {
  try {
    localStorage.setItem(activeSubjectStorageKey, subject)
  } catch {
    // The in-memory flight cache remains isolated by the supplied subject.
  }
}

/** Clears the active notification subject during account transitions. */
export function clearActiveFlightStorageSubject() {
  try {
    localStorage.removeItem(activeSubjectStorageKey)
  } catch {
    // A stale subject is harmless when browser storage is unavailable.
  }
}

/** Encodes one account/family subject into its pending-create registry key. */
function pendingCreateStorageKey(subject: string) {
  return `${pendingCreateStoragePrefix}${encodeURIComponent(subject)}`
}

/** Compares the normalized fields that define one logical create attempt. */
function samePendingCreateIdentity(
  intent: PendingFlightCreateIdentity,
  identity: PendingFlightCreateIdentity,
) {
  return intent.travelerName === identity.travelerName
    && intent.flightNumber === identity.flightNumber
    && intent.travelDate === identity.travelDate
}

/** Drops malformed, expired, and implausibly future idempotency records. */
function safePendingCreateIntents(value: unknown, now: number) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is PendingFlightCreateIntent => {
    if (!item || typeof item !== 'object') return false
    const intent = item as Partial<PendingFlightCreateIntent>
    return typeof intent.id === 'string'
      && intent.id.length > 0
      && typeof intent.travelerName === 'string'
      && intent.travelerName.length > 0
      && typeof intent.flightNumber === 'string'
      && normalizeFlightNumber(intent.flightNumber) === intent.flightNumber
      && typeof intent.travelDate === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(intent.travelDate)
      && typeof intent.createdAt === 'number'
      && Number.isFinite(intent.createdAt)
      && now - intent.createdAt <= pendingCreateLifetimeMs
      && intent.createdAt <= now + 60_000
  })
}

/** Reads pending creates with an account-isolated in-memory fallback. */
function readPendingCreateIntents(subject: string, now = Date.now()) {
  const key = pendingCreateStorageKey(subject)
  try {
    const stored = localStorage.getItem(key)
    if (!stored) return pendingCreateMemoryStorage.get(key) ?? []
    return safePendingCreateIntents(JSON.parse(stored) as unknown, now)
  } catch {
    return pendingCreateMemoryStorage.get(key) ?? []
  }
}

/** Persists pending creates or retains them in memory when storage fails. */
function writePendingCreateIntents(
  subject: string,
  intents: PendingFlightCreateIntent[],
) {
  const key = pendingCreateStorageKey(subject)
  try {
    if (intents.length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(intents))
    pendingCreateMemoryStorage.delete(key)
  } catch {
    pendingCreateMemoryStorage.set(key, intents)
  }
}

/** Reuses the same server row ID when a previous create may have succeeded. */
export function getOrCreatePendingFlightCreateId(
  subject: string,
  identity: PendingFlightCreateIdentity,
  createId: () => string,
  now = Date.now(),
) {
  const intents = readPendingCreateIntents(subject, now)
  const pending = intents.find((intent) =>
    samePendingCreateIdentity(intent, identity),
  )
  if (pending) return pending.id
  const id = createId()
  writePendingCreateIntents(subject, [
    ...intents,
    { ...identity, id, createdAt: now },
  ])
  return id
}

/** Removes an idempotent create intent after the server confirms its row. */
export function clearPendingFlightCreateIntent(
  subject: string,
  identity: PendingFlightCreateIdentity,
) {
  writePendingCreateIntents(
    subject,
    readPendingCreateIntents(subject).filter((intent) =>
      !samePendingCreateIdentity(intent, identity),
    ),
  )
}

/** Accepts only timestamp strings the runtime can parse. */
function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime())
}

/** Validates nullable provider timestamp fields. */
function isOptionalTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value)
}

/** Bounds geographic coordinates before route-map projection. */
function isCoordinates(value: unknown): value is {
  latitude: number
  longitude: number
} {
  if (!value || typeof value !== 'object') return false
  const item = value as { latitude?: unknown; longitude?: unknown }
  return typeof item.latitude === 'number'
    && Number.isFinite(item.latitude)
    && item.latitude >= -90
    && item.latitude <= 90
    && typeof item.longitude === 'number'
    && Number.isFinite(item.longitude)
    && item.longitude >= -180
    && item.longitude <= 180
}

/** Validates airport identity, coordinates, and IANA time-zone data. */
function isAirport(value: unknown): value is FlightAirport {
  if (!isCoordinates(value)) return false
  const airport = value as Partial<FlightAirport>
  return typeof airport.code === 'string'
    && airport.code.length > 0
    && (airport.name === null || typeof airport.name === 'string')
    && (airport.city === null || typeof airport.city === 'string')
    && typeof airport.timeZone === 'string'
    && isTimeZone(airport.timeZone)
}

/** Uses Intl as the source of truth for supported IANA time-zone names. */
function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

/** Validates an optional live position and its nullable telemetry. */
function isPosition(value: unknown) {
  if (value === null) return true
  if (!isCoordinates(value)) return false
  const position = value as {
    altitudeFeet?: unknown
    headingDegrees?: unknown
    recordedAt?: unknown
  }
  return (position.altitudeFeet === null || typeof position.altitudeFeet === 'number')
    && (position.headingDegrees === null || typeof position.headingDegrees === 'number')
    && (position.recordedAt === null || isIsoTimestamp(position.recordedAt))
}

/** Validates an untrusted provider or persisted flight-status snapshot. */
export function isFlightStatusSnapshot(
  value: unknown,
): value is FlightStatusSnapshot {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<FlightStatusSnapshot>
  return (item.provider === 'flightaware' || item.provider === 'aerodatabox')
    && typeof item.flightNumber === 'string'
    && normalizeFlightNumber(item.flightNumber) === item.flightNumber
    && /^[A-Z0-9]{3,8}$/.test(item.flightNumber)
    && !looksLikeTicketNumber(item.flightNumber)
    && (
      item.operatingFlightNumber === undefined
      || item.operatingFlightNumber === null
      || (
        typeof item.operatingFlightNumber === 'string'
        && normalizeFlightNumber(item.operatingFlightNumber)
          === item.operatingFlightNumber
        && !looksLikeTicketNumber(item.operatingFlightNumber)
      )
    )
    && (item.providerFlightId === null || typeof item.providerFlightId === 'string')
    && typeof item.status === 'string'
    && ['live', 'estimated', 'scheduled'].includes(item.dataQuality ?? '')
    && isAirport(item.origin)
    && isAirport(item.destination)
    && isOptionalTimestamp(item.scheduledDeparture)
    && isOptionalTimestamp(item.estimatedDeparture)
    && isOptionalTimestamp(item.actualDeparture)
    && isOptionalTimestamp(item.scheduledArrival)
    && isOptionalTimestamp(item.estimatedArrival)
    && isOptionalTimestamp(item.actualArrival)
    && (
      item.progressPercent === null
      || (
        typeof item.progressPercent === 'number'
        && Number.isFinite(item.progressPercent)
      )
    )
    && isPosition(item.position)
    && isIsoTimestamp(item.updatedAt)
}

/** Validates a complete tracked-flight record at storage boundaries. */
export function isTrackedFlight(value: unknown): value is TrackedFlight {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<TrackedFlight>
  return typeof item.id === 'string'
    && item.id.length > 0
    && typeof item.travelerName === 'string'
    && item.travelerName.trim().length > 0
    && typeof item.flightNumber === 'string'
    && normalizeFlightNumber(item.flightNumber) === item.flightNumber
    && !looksLikeTicketNumber(item.flightNumber)
    && /^\d{4}-\d{2}-\d{2}$/.test(item.travelDate ?? '')
    && isIsoTimestamp(item.createdAt)
    && typeof item.notificationEnabled === 'boolean'
    && typeof item.synced === 'boolean'
    && isFlightStatusSnapshot(item.snapshot)
    && item.snapshot.flightNumber === item.flightNumber
}

/** Reads only valid flights from the account/family-scoped cache. */
export function readTrackedFlights(accountId: string): TrackedFlight[] {
  const key = flightStorageKey(accountId)
  try {
    const stored = localStorage.getItem(key)
    if (!stored) return memoryStorage.get(key) ?? []
    const parsed = JSON.parse(stored) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isTrackedFlight)
  } catch {
    return memoryStorage.get(key) ?? []
  }
}

/** Revalidates and persists tracked flights with an in-memory fallback. */
export function writeTrackedFlights(
  accountId: string,
  flights: TrackedFlight[],
) {
  // Revalidate at the persistence boundary. Provider/cache corruption is
  // dropped before it becomes durable, while the memory fallback preserves
  // the same account isolation when localStorage is unavailable or full.
  const safeFlights = flights.filter(isTrackedFlight)
  const key = flightStorageKey(accountId)
  try {
    localStorage.setItem(key, JSON.stringify(safeFlights))
    memoryStorage.delete(key)
  } catch {
    memoryStorage.set(key, safeFlights)
  }
  return safeFlights
}

/**
 * Reconciles authoritative family rows with unsynced device rows while keeping
 * each device's notification preference local.
 */
export function mergeTrackedFlights(
  localFlights: TrackedFlight[],
  familyFlights: TrackedFlight[],
) {
  const localById = new Map(localFlights.map((flight) => [flight.id, flight]))
  // Synced rows are authoritative on the server, so absence means deletion;
  // genuinely local rows survive offline. Alert opt-in remains device-local
  // and is deliberately overlaid instead of being shared with family members.
  const merged = new Map(
    localFlights
      .filter((flight) => !flight.synced)
      .map((flight) => [flight.id, flight]),
  )
  for (const familyFlight of familyFlights) {
    const local = localById.get(familyFlight.id)
    merged.set(familyFlight.id, {
      ...familyFlight,
      notificationEnabled: local?.notificationEnabled ?? false,
      synced: true,
    })
  }
  return [...merged.values()].sort((left, right) => {
    const leftDeparture = left.snapshot.scheduledDeparture ?? `${left.travelDate}T23:59:59Z`
    const rightDeparture = right.snapshot.scheduledDeparture ?? `${right.travelDate}T23:59:59Z`
    return new Date(leftDeparture).getTime() - new Date(rightDeparture).getTime()
  })
}
