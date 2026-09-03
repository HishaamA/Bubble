import {
  isFreshProviderPosition,
  normalizeAirlineFlightNumber,
} from './providerHelpers.ts'

type JsonObject = Record<string, unknown>

type NormalizedAirport = {
  code: string
  name: string | null
  city: string | null
  latitude: number
  longitude: number
  timeZone: string
}

type NormalizedPosition = {
  latitude: number
  longitude: number
  altitudeFeet: number | null
  headingDegrees: number | null
  recordedAt: string
}

export type AeroDataBoxStatusSnapshot = {
  provider: 'aerodatabox'
  providerFlightId: string | null
  flightNumber: string
  operatingFlightNumber: string | null
  status: string
  dataQuality: 'live' | 'estimated' | 'scheduled'
  origin: NormalizedAirport
  destination: NormalizedAirport
  scheduledDeparture: string | null
  estimatedDeparture: string | null
  actualDeparture: string | null
  scheduledArrival: string | null
  estimatedArrival: string | null
  actualArrival: string | null
  progressPercent: null
  position: NormalizedPosition | null
  updatedAt: string
}

export type AeroDataBoxFlightChoice = {
  providerFlightId: string
  flightNumber: string
  operatingFlightNumber: string | null
  origin: {
    code: string
    name: string | null
    city: string | null
    timeZone: string | null
  }
  destination: {
    code: string
    name: string | null
    city: string | null
    timeZone: string | null
  }
  scheduledDeparture: string
  scheduledArrival: string | null
}

export type AeroDataBoxLookupResult =
  | { kind: 'created'; snapshot: AeroDataBoxStatusSnapshot }
  | { kind: 'choices'; choices: AeroDataBoxFlightChoice[] }

export type AeroDataBoxProviderErrorCode =
  | 'auth'
  | 'plan'
  | 'quota'
  | 'rate'
  | 'unavailable'
  | 'incomplete'

/** A safe, finite error contract understood by the Edge Function boundary. */
export class AeroDataBoxProviderError extends Error {
  readonly code: AeroDataBoxProviderErrorCode

  constructor(message: string, errorCode: AeroDataBoxProviderErrorCode) {
    super(message)
    this.name = 'AeroDataBoxProviderError'
    this.code = errorCode
  }
}

const providerBaseUrl = 'https://aerodatabox.p.rapidapi.com'
const providerHost = 'aerodatabox.p.rapidapi.com'
const responseCacheTtlMs = 60_000
const airportCacheTtlMs = 24 * 60 * 60 * 1000
const livePositionFreshnessMs = 15 * 60 * 1000
const maximumResponseCacheEntries = 256
const maximumAirportCacheEntries = 512
const providerMinimumRequestIntervalMs = 1_000
const maximumRetryAfterDelayMs = 5_000

const departureCompletedStatusTokens = new Set([
  'departed',
  'enroute',
  'approaching',
  'arrived',
  'diverted',
])
const operationalStatusTokens = new Set([
  'checkin',
  'boarding',
  'gateclosed',
  'departed',
  'enroute',
  'approaching',
  'delayed',
])

const responseCache = new Map<string, {
  expiresAt: number
  value: AeroDataBoxLookupResult | null
}>()
const airportCache = new Map<string, {
  expiresAt: number
  value: NormalizedAirport
}>()
const inFlightLookups = new Map<
  string,
  Promise<AeroDataBoxLookupResult | null>
>()
let providerRequestTail: Promise<void> = Promise.resolve()
let nextProviderRequestAt = 0

/** Narrows untrusted provider JSON without accepting arrays or null. */
function asJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

/** Trims non-empty provider text and rejects every other JSON value. */
function normalizedText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Converts finite provider numbers while rejecting blanks and infinities. */
function finiteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Normalizes provider timestamps before they enter the persisted snapshot. */
function normalizedTimestamp(value: unknown) {
  const candidate = normalizedText(value)
  if (!candidate) return null
  const parsed = new Date(candidate)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

/** Accepts only real calendar dates in the provider's YYYY-MM-DD format. */
function normalizedCalendarDate(value: unknown) {
  const candidate = normalizedText(value)
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null
  const [year, month, day] = candidate.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? candidate
    : null
}

function validTimeZone(value: unknown) {
  const candidate = normalizedText(value)
  if (!candidate) return null
  try {
    new Intl.DateTimeFormat('en', { timeZone: candidate }).format(0)
    return candidate
  } catch {
    return null
  }
}

/** Normalizes an IATA or ICAO airport identifier. */
function normalizeAirportCode(value: unknown, length: 3 | 4) {
  const candidate = normalizedText(value)?.toUpperCase()
  return candidate && new RegExp(`^[A-Z0-9]{${length}}$`).test(candidate)
    ? candidate
    : null
}

function boundedCacheSet<T>(
  cache: Map<string, { expiresAt: number; value: T }>,
  key: string,
  value: T,
  ttlMs: number,
  maximumEntries: number,
) {
  // Prune expired entries first, then evict insertion-order entries. The maps
  // are small and this avoids a second cache implementation in the Edge worker.
  const now = Date.now()
  for (const [cachedKey, cached] of cache) {
    if (cached.expiresAt <= now) cache.delete(cachedKey)
  }
  while (cache.size >= maximumEntries) {
    const oldestKey = cache.keys().next().value as string | undefined
    if (!oldestKey) break
    cache.delete(oldestKey)
  }
  cache.set(key, { value, expiresAt: now + ttlMs })
}

/** Flattens provider error contracts without exposing them to app clients. */
function providerErrorText(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase()
  if (Array.isArray(value)) return value.map(providerErrorText).join(' ')
  const record = asJsonObject(value)
  if (!record) return ''
  return [
    record.message,
    record.error,
    record.detail,
    record.details,
    record.description,
    record.reason,
    record.code,
    record.key,
  ]
    .map(providerErrorText)
    .join(' ')
}

function isPlanRestriction(details: string) {
  return /subscri|pricing|\bplan\b|not allowed|not available|historical depth|future depth|date range limit/.test(
    details,
  )
}

/** Maps provider-specific HTTP failures to the small public error taxonomy. */
function mappedHttpError(response: Response, responseBody: unknown) {
  const details = providerErrorText(responseBody)
  if (response.status === 401) {
    return new AeroDataBoxProviderError(
      'The configured AeroDataBox key was rejected.',
      'auth',
    )
  }
  if (response.status === 403) {
    if (isPlanRestriction(details)) {
      return new AeroDataBoxProviderError(
        'The AeroDataBox plan does not include this flight lookup.',
        'plan',
      )
    }
    return new AeroDataBoxProviderError(
      'The configured AeroDataBox key was rejected.',
      'auth',
    )
  }
  if (response.status === 400) {
    return isPlanRestriction(details)
      ? new AeroDataBoxProviderError(
          'The AeroDataBox plan does not include this flight lookup.',
          'plan',
        )
      : new AeroDataBoxProviderError(
          'AeroDataBox rejected the flight lookup parameters.',
          'incomplete',
        )
  }
  if (response.status === 429) {
    const quotaExhausted = /quota|monthly|subscription limit/.test(details)
      || response.headers.get('x-ratelimit-requests-remaining') === '0'
        && !/rate limit|too many requests/.test(details)
    return quotaExhausted
      ? new AeroDataBoxProviderError(
          'The AeroDataBox request quota has been reached.',
          'quota',
        )
      : new AeroDataBoxProviderError(
          'AeroDataBox is receiving too many requests.',
          'rate',
        )
  }
  return new AeroDataBoxProviderError(
    'AeroDataBox returned an unavailable response.',
    'unavailable',
  )
}

function delayFor(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

async function waitForProviderSlot(minimumDelay = 0) {
  const delayMs = Math.max(
    0,
    minimumDelay,
    nextProviderRequestAt - Date.now(),
  )
  if (delayMs > 0) await delayFor(delayMs)
  nextProviderRequestAt = Date.now() + providerMinimumRequestIntervalMs
}

/** Serializes calls so concurrent lookups cannot exceed the provider quota. */
function scheduledProviderRequest<T>(providerOperation: () => Promise<T>) {
  const scheduledOperation = providerRequestTail.then(providerOperation)
  providerRequestTail = scheduledOperation.then(
    () => undefined,
    () => undefined,
  )
  return scheduledOperation
}

function retryAfterDelay(response: Response) {
  const retryAfterHeader = normalizedText(response.headers.get('retry-after'))
  let requestedDelayMs = providerMinimumRequestIntervalMs
  if (retryAfterHeader) {
    const retryAfterSeconds = Number(retryAfterHeader)
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      requestedDelayMs = retryAfterSeconds * 1_000
    } else {
      const retryAt = new Date(retryAfterHeader).getTime()
      if (Number.isFinite(retryAt)) requestedDelayMs = retryAt - Date.now()
    }
  }
  return Math.min(
    maximumRetryAfterDelayMs,
    Math.max(providerMinimumRequestIntervalMs, requestedDelayMs),
  )
}

async function providerAttempt(path: string, apiKey: string) {
  let response: Response
  try {
    response = await fetch(`${providerBaseUrl}${path}`, {
      headers: {
        Accept: 'application/json',
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': providerHost,
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new AeroDataBoxProviderError(
      'AeroDataBox is temporarily unreachable.',
      'unavailable',
    )
  }
  let responseBody: unknown = null
  if (response.status !== 204) {
    try {
      responseBody = await response.json()
    } catch {
      // Keep provider HTML and malformed error bodies away from the client.
    }
  }
  return { response, responseBody }
}

function providerAttemptValue(attempt: {
  response: Response
  responseBody: unknown
}) {
  if (attempt.response.status === 204) return null
  if (!attempt.response.ok) {
    throw mappedHttpError(attempt.response, attempt.responseBody)
  }
  const { responseBody } = attempt
  if (responseBody === null) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox returned an incomplete response.',
      'incomplete',
    )
  }
  return responseBody
}

async function providerRequest(path: string, apiKey: string) {
  return scheduledProviderRequest(async () => {
    await waitForProviderSlot()
    let attempt = await providerAttempt(path, apiKey)
    if (attempt.response.status === 429) {
      const error = mappedHttpError(attempt.response, attempt.responseBody)
      if (error.code === 'rate') {
        await waitForProviderSlot(retryAfterDelay(attempt.response))
        attempt = await providerAttempt(path, apiKey)
      }
    }
    return providerAttemptValue(attempt)
  })
}

/** Reads the origin-local departure day used by the public flight lookup. */
function localMovementDate(movement: JsonObject) {
  const scheduledTime = asJsonObject(movement.scheduledTime)
  const localTimestamp = normalizedText(scheduledTime?.local)
  if (!localTimestamp || localTimestamp.length < 10) return null
  return normalizedCalendarDate(localTimestamp.slice(0, 10))
}

function canonicalFlightSuffix(value: string) {
  const match = /^(\d+)([A-Z]?)$/.exec(value)
  if (!match) return null
  return `${match[1].replace(/^0+(?=\d)/, '')}${match[2]}`
}

function airlineDesignators(row: JsonObject) {
  const airline = asJsonObject(row.airline)
  return [
    normalizedText(airline?.iata)?.toUpperCase(),
    normalizedText(airline?.icao)?.toUpperCase(),
  ].filter((value): value is string =>
    value !== undefined
      && value !== null
      && /^[A-Z0-9]{2,3}$/.test(value),
  )
}

function suffixAfterDesignator(flightNumber: string, designator: string) {
  if (!flightNumber.startsWith(designator)) return null
  return canonicalFlightSuffix(flightNumber.slice(designator.length))
}

function genericFlightParts(flightNumber: string) {
  const match = /^([A-Z]{2,3})(\d+[A-Z]?)$/.exec(flightNumber)
  const suffix = match ? canonicalFlightSuffix(match[2]) : null
  return match && suffix
    ? { designator: match[1], suffix }
    : null
}

function equivalentFlightNumber(
  row: JsonObject,
  requestedFlightNumber: string,
) {
  const returnedFlightNumber = normalizeAirlineFlightNumber(row.number)
  if (!returnedFlightNumber) return false
  if (returnedFlightNumber === requestedFlightNumber) return true

  // AeroDataBox may return an operating IATA/ICAO number for a requested
  // codeshare. Compare the canonical numeric suffix across both designators.
  const designators = airlineDesignators(row)
  for (const requestedDesignator of designators) {
    const requestedSuffix = suffixAfterDesignator(
      requestedFlightNumber,
      requestedDesignator,
    )
    if (!requestedSuffix) continue
    for (const returnedDesignator of designators) {
      if (
        suffixAfterDesignator(returnedFlightNumber, returnedDesignator)
        === requestedSuffix
      ) return true
    }
  }

  const requestedParts = genericFlightParts(requestedFlightNumber)
  const returnedParts = genericFlightParts(returnedFlightNumber)
  return requestedParts !== null
    && returnedParts !== null
    && requestedParts.designator === returnedParts.designator
    && requestedParts.suffix === returnedParts.suffix
}

function rowMatchesDepartureDate(row: JsonObject, travelDate: string) {
  const departure = asJsonObject(row.departure)
  return departure !== null && localMovementDate(departure) === travelDate
}

function candidateProviderFlightId(row: JsonObject) {
  const providerNumber = normalizeAirlineFlightNumber(row.number)
  const scheduledDeparture = movementTimestamp(
    asJsonObject(row.departure),
    'scheduledTime',
  )
  return providerNumber && scheduledDeparture
    ? `${providerNumber}:${scheduledDeparture}`
    : providerNumber
}

function matchingFlightRows(
  providerResponse: unknown,
  flightNumber: string,
  travelDate: string,
) {
  if (!Array.isArray(providerResponse)) return []
  const datedRows = providerResponse
    .map(asJsonObject)
    .filter((row): row is JsonObject => row !== null)
    .filter((row) => rowMatchesDepartureDate(row, travelDate))
  const exactMatches = datedRows.filter((row) =>
    equivalentFlightNumber(row, flightNumber),
  )
  // The endpoint is already scoped to the requested number. An operator-row
  // fallback covers codeshares whose returned number uses another designator.
  const operatorMatches = datedRows.filter((row) =>
    normalizedText(row.codeshareStatus)?.toLowerCase() === 'isoperator',
  )
  const matches = exactMatches.length > 0 ? exactMatches : operatorMatches
  const uniqueMatches = new Map<string, JsonObject>()
  for (const row of matches) {
    const identity = candidateProviderFlightId(row)
    if (identity) uniqueMatches.set(identity, row)
  }
  return [...uniqueMatches.values()].sort((left, right) => {
    const leftDeparture = movementTimestamp(asJsonObject(left.departure), 'scheduledTime')
    const rightDeparture = movementTimestamp(asJsonObject(right.departure), 'scheduledTime')
    return (leftDeparture ?? '').localeCompare(rightDeparture ?? '')
  })
}

function embeddedAirportChoice(value: unknown) {
  const airport = asJsonObject(value)
  if (!airport) return null
  const iata = normalizeAirportCode(airport.iata, 3)
  const icao = normalizeAirportCode(airport.icao, 4)
  const airportCode = iata ?? icao
  if (!airportCode) return null
  return {
    code: airportCode,
    name: normalizedText(airport.name) ?? normalizedText(airport.shortName),
    city: normalizedText(airport.municipalityName),
    timeZone: validTimeZone(airport.timeZone),
  }
}

function flightChoice(
  row: JsonObject,
  requestedFlightNumber: string,
): AeroDataBoxFlightChoice | null {
  const providerFlightId = candidateProviderFlightId(row)
  const providerFlightNumber = normalizeAirlineFlightNumber(row.number)
  const departure = asJsonObject(row.departure)
  const arrival = asJsonObject(row.arrival)
  const origin = embeddedAirportChoice(departure?.airport)
  const destination = embeddedAirportChoice(arrival?.airport)
  const scheduledDeparture = movementTimestamp(departure, 'scheduledTime')
  const scheduledArrival = movementTimestamp(arrival, 'scheduledTime')
  if (
    !providerFlightId
    || !providerFlightNumber
    || !origin
    || !destination
    || !scheduledDeparture
  ) return null
  return {
    providerFlightId,
    flightNumber: requestedFlightNumber,
    operatingFlightNumber: equivalentFlightNumber(row, requestedFlightNumber)
      ? null
      : providerFlightNumber,
    origin,
    destination,
    scheduledDeparture,
    scheduledArrival,
  }
}

function movementTimestamp(
  movement: JsonObject | null,
  field: 'scheduledTime' | 'revisedTime' | 'predictedTime' | 'runwayTime',
) {
  const movementTime = asJsonObject(movement?.[field])
  return normalizedTimestamp(movementTime?.utc)
    ?? normalizedTimestamp(movementTime?.local)
}

function embeddedAirportIdentity(value: JsonObject) {
  const iata = normalizeAirportCode(value.iata, 3)
  const icao = normalizeAirportCode(value.icao, 4)
  const airportCode = iata ?? icao
  if (!airportCode) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox omitted an airport identifier.',
      'incomplete',
    )
  }
  return {
    code: airportCode,
    kind: iata ? 'Iata' as const : 'Icao' as const,
    iata,
    icao,
  }
}

function normalizedAirport(
  value: JsonObject,
  expectedCode: string,
): NormalizedAirport | null {
  const location = asJsonObject(value.location)
  const latitude = finiteNumber(location?.lat)
  const longitude = finiteNumber(location?.lon)
  const timeZone = validTimeZone(value.timeZone)
  const candidateIata = normalizeAirportCode(value.iata, 3)
  const candidateIcao = normalizeAirportCode(value.icao, 4)
  if (
    expectedCode !== candidateIata
    && expectedCode !== candidateIcao
  ) return null
  if (
    latitude === null
    || latitude < -90
    || latitude > 90
    || longitude === null
    || longitude < -180
    || longitude > 180
    || !timeZone
  ) return null
  return {
    code: expectedCode,
    name: normalizedText(value.name) ?? normalizedText(value.shortName),
    city: normalizedText(value.municipalityName),
    latitude,
    longitude,
    timeZone,
  }
}

function previousAirport(value: unknown, expectedCode: string) {
  const previous = asJsonObject(value)
  if (normalizedText(previous?.code)?.toUpperCase() !== expectedCode) return null
  return previous ? normalizedAirport({
    iata: expectedCode.length === 3 ? expectedCode : null,
    icao: expectedCode.length === 4 ? expectedCode : null,
    name: previous.name,
    municipalityName: previous.city,
    location: {
      lat: previous.latitude,
      lon: previous.longitude,
    },
    timeZone: previous.timeZone,
  }, expectedCode) : null
}

async function airportDetails(
  movementValue: unknown,
  apiKey: string,
  previousValue: unknown,
) {
  const movement = asJsonObject(movementValue)
  const embedded = asJsonObject(movement?.airport)
  if (!embedded) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox omitted airport details.',
      'incomplete',
    )
  }
  const identity = embeddedAirportIdentity(embedded)
  const completeEmbedded = normalizedAirport(embedded, identity.code)
  if (completeEmbedded) return completeEmbedded

  // A prior verified snapshot is preferable to spending another provider unit
  // when the current flight payload omits coordinates or its time zone.
  const fromPrevious = previousAirport(previousValue, identity.code)
  if (fromPrevious) {
    return {
      ...fromPrevious,
      name: normalizedText(embedded.name)
        ?? normalizedText(embedded.shortName)
        ?? fromPrevious.name,
      city: normalizedText(embedded.municipalityName) ?? fromPrevious.city,
      timeZone: validTimeZone(embedded.timeZone) ?? fromPrevious.timeZone,
    }
  }

  const cacheKey = `aerodatabox:airport:${identity.kind}:${identity.code}`
  const cached = airportCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const airportResponse = await providerRequest(
    `/airports/${identity.kind}/${encodeURIComponent(identity.code)}`,
    apiKey,
  )
  const responseAirport = asJsonObject(airportResponse)
  const normalizedResponseAirport = responseAirport
    ? normalizedAirport(responseAirport, identity.code)
    : null
  if (!normalizedResponseAirport) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox returned incomplete airport details.',
      'incomplete',
    )
  }
  const mergedAirport = {
    ...normalizedResponseAirport,
    name: normalizedText(embedded.name)
      ?? normalizedText(embedded.shortName)
      ?? normalizedResponseAirport.name,
    city: normalizedText(embedded.municipalityName)
      ?? normalizedResponseAirport.city,
    timeZone: validTimeZone(embedded.timeZone)
      ?? normalizedResponseAirport.timeZone,
  }
  boundedCacheSet(
    airportCache,
    cacheKey,
    mergedAirport,
    airportCacheTtlMs,
    maximumAirportCacheEntries,
  )
  return mergedAirport
}

function normalizedStatus(value: unknown) {
  const raw = normalizedText(value) ?? 'Unknown'
  const token = raw.toLowerCase().replace(/[^a-z]/g, '')
  const labels: Record<string, string> = {
    unknown: 'Status unavailable',
    scheduled: 'Scheduled',
    expected: 'Expected',
    enroute: 'En route',
    checkin: 'Check-in',
    boarding: 'Boarding',
    gateclosed: 'Gate closed',
    departed: 'Departed',
    delayed: 'Delayed',
    approaching: 'Approaching',
    arrived: 'Arrived',
    canceled: 'Cancelled',
    cancelled: 'Cancelled',
    canceleduncertain: 'Possibly cancelled',
    cancelleduncertain: 'Possibly cancelled',
    diverted: 'Diverted',
  }
  return { token, label: labels[token] ?? raw.replace(/\b\w/g, (letter) => letter.toUpperCase()) }
}

function movementTimes(movement: JsonObject | null, completed: boolean) {
  const scheduled = movementTimestamp(movement, 'scheduledTime')
  const revised = movementTimestamp(movement, 'revisedTime')
  const runway = movementTimestamp(movement, 'runwayTime')
  const predicted = movementTimestamp(movement, 'predictedTime')
  const actual = completed ? runway ?? revised : null
  return {
    scheduled,
    actual,
    estimated: actual ? null : revised ?? runway ?? predicted,
    hasProviderUpdate: revised !== null
      || runway !== null
      || predicted !== null,
  }
}

function normalizedPosition(value: unknown): NormalizedPosition | null {
  const location = asJsonObject(value)
  const latitude = finiteNumber(location?.lat)
  const longitude = finiteNumber(location?.lon)
  const altitude = asJsonObject(location?.altitude)
  const track = asJsonObject(location?.trueTrack)
  const altitudeFeet = finiteNumber(altitude?.feet)
  const heading = finiteNumber(track?.deg)
  const recordedAt = normalizedTimestamp(location?.reportedAtUtc)
  if (
    latitude === null
    || latitude < -90
    || latitude > 90
    || longitude === null
    || longitude < -180
    || longitude > 180
    || !recordedAt
  ) return null
  return {
    latitude,
    longitude,
    altitudeFeet,
    headingDegrees: heading === null ? null : ((heading % 360) + 360) % 360,
    recordedAt,
  }
}

function movementHasLiveQuality(value: JsonObject | null) {
  const quality = value?.quality
  return Array.isArray(quality)
    && quality.some((item) => normalizedText(item)?.toLowerCase() === 'live')
}

function latestTimestamp(...values: Array<string | null | undefined>) {
  let latest: { epochMilliseconds: number; value: string } | null = null
  for (const value of values) {
    if (!value) continue
    const parsed = new Date(value).getTime()
    if (!Number.isFinite(parsed)) continue
    if (!latest || parsed > latest.epochMilliseconds) {
      latest = {
        epochMilliseconds: parsed,
        value: new Date(parsed).toISOString(),
      }
    }
  }
  return latest?.value ?? null
}

async function buildNormalizedStatus(
  selected: JsonObject,
  flightNumber: string,
  apiKey: string,
  previousSnapshot: unknown,
): Promise<AeroDataBoxStatusSnapshot> {
  const providerFlightNumber = normalizeAirlineFlightNumber(selected.number)
  if (!providerFlightNumber) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox omitted the operating flight number.',
      'incomplete',
    )
  }

  const departure = asJsonObject(selected.departure)
  const arrival = asJsonObject(selected.arrival)
  if (!departure || !arrival) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox omitted flight movement details.',
      'incomplete',
    )
  }
  const previous = asJsonObject(previousSnapshot)
  const [origin, destination] = await Promise.all([
    airportDetails(departure, apiKey, previous?.origin),
    airportDetails(arrival, apiKey, previous?.destination),
  ])
  const status = normalizedStatus(selected.status)
  const departureCompleted = departureCompletedStatusTokens.has(status.token)
  const arrivalCompleted = status.token === 'arrived'
  const departureTimes = movementTimes(departure, departureCompleted)
  const arrivalTimes = movementTimes(arrival, arrivalCompleted)
  const position = normalizedPosition(selected.location)
  const freshPosition = isFreshProviderPosition(
    position,
    Date.now(),
    livePositionFreshnessMs,
  )
  const operationalStatus = operationalStatusTokens.has(status.token)
  const liveMovement = operationalStatus
    && (movementHasLiveQuality(departure) || movementHasLiveQuality(arrival))
  const hasEstimate = departureTimes.hasProviderUpdate
    || arrivalTimes.hasProviderUpdate
    || movementHasLiveQuality(departure)
    || movementHasLiveQuality(arrival)
  const dataQuality = freshPosition || liveMovement
    ? 'live'
    : hasEstimate
      ? 'estimated'
      : 'scheduled'
  const updatedAt = latestTimestamp(
    position?.recordedAt,
    normalizedTimestamp(selected.lastUpdatedUtc),
  )
    ?? new Date().toISOString()
  const providerFlightId = candidateProviderFlightId(selected)
  const operatingFlightNumber = equivalentFlightNumber(selected, flightNumber)
    ? null
    : providerFlightNumber

  return {
    provider: 'aerodatabox',
    providerFlightId,
    flightNumber,
    operatingFlightNumber,
    status: status.label,
    dataQuality,
    origin,
    destination,
    scheduledDeparture: departureTimes.scheduled,
    estimatedDeparture: departureTimes.estimated,
    actualDeparture: departureTimes.actual,
    scheduledArrival: arrivalTimes.scheduled,
    estimatedArrival: arrivalTimes.estimated,
    actualArrival: arrivalTimes.actual,
    progressPercent: null,
    position,
    updatedAt,
  }
}

async function buildLookupResult(
  flightNumber: string,
  travelDate: string,
  apiKey: string,
  previousSnapshot: unknown,
  selectedProviderFlightId: string | null,
): Promise<AeroDataBoxLookupResult | null> {
  const providerResponse = await providerRequest(
    `/flights/number/${encodeURIComponent(flightNumber)}/${travelDate}`
      + '?dateLocalRole=Departure&withLocation=true&withAircraftImage=false',
    apiKey,
  )
  if (providerResponse === null) return null
  const matches = matchingFlightRows(
    providerResponse,
    flightNumber,
    travelDate,
  )
  if (matches.length === 0) return null

  const previous = asJsonObject(previousSnapshot)
  const previousProviderFlightId = normalizedText(previous?.providerFlightId)
  const requestedProviderFlightId = selectedProviderFlightId
    ?? previousProviderFlightId
  if (requestedProviderFlightId) {
    const selected = matches.find((row) =>
      candidateProviderFlightId(row) === requestedProviderFlightId,
    )
    if (!selected) return null
    return {
      kind: 'created',
      snapshot: await buildNormalizedStatus(
        selected,
        flightNumber,
        apiKey,
        previousSnapshot,
      ),
    }
  }

  if (matches.length === 1) {
    return {
      kind: 'created',
      snapshot: await buildNormalizedStatus(
        matches[0],
        flightNumber,
        apiKey,
        previousSnapshot,
      ),
    }
  }

  const choices = matches
    .map((row) => flightChoice(row, flightNumber))
    .filter((choice): choice is AeroDataBoxFlightChoice => choice !== null)
  if (choices.length !== matches.length) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox returned incomplete flight choice details.',
      'incomplete',
    )
  }
  return { kind: 'choices', choices }
}

/**
 * Resolves an exact departure-day flight, returning choices when the provider
 * reports multiple occurrences. Responses are short-lived and coalesced to
 * protect the shared provider quota.
 */
export async function aerodataboxLookup(
  requestedFlightNumber: string,
  requestedTravelDate: string,
  apiKey: string,
  previousSnapshot: unknown = null,
  selectedProviderFlightId: string | null = null,
) {
  const flightNumber = normalizeAirlineFlightNumber(requestedFlightNumber)
  const travelDate = normalizedCalendarDate(requestedTravelDate)
  if (!flightNumber || !travelDate) {
    throw new AeroDataBoxProviderError(
      'The flight lookup identity is invalid.',
      'incomplete',
    )
  }
  const selectedIdentity = selectedProviderFlightId?.trim() || null
  if (selectedIdentity && (
    selectedIdentity.length > 160
    || !/^[A-Z0-9]+:[0-9T:.Z+-]+$/.test(selectedIdentity)
  )) {
    throw new AeroDataBoxProviderError(
      'The selected provider flight identity is invalid.',
      'incomplete',
    )
  }
  const previousProviderFlightId = normalizedText(
    asJsonObject(previousSnapshot)?.providerFlightId,
  )
  const cacheIdentity = selectedIdentity
    ?? previousProviderFlightId
    ?? 'unselected'
  const cacheKey = `aerodatabox:status:${flightNumber}:${travelDate}:${cacheIdentity}`
  const cached = responseCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = inFlightLookups.get(cacheKey)
  if (existing) return existing

  const lookup = buildLookupResult(
    flightNumber,
    travelDate,
    apiKey,
    previousSnapshot,
    selectedIdentity,
  )
  inFlightLookups.set(cacheKey, lookup)
  try {
    const lookupResult = await lookup
    boundedCacheSet(
      responseCache,
      cacheKey,
      lookupResult,
      responseCacheTtlMs,
      maximumResponseCacheEntries,
    )
    return lookupResult
  } finally {
    if (inFlightLookups.get(cacheKey) === lookup) {
      inFlightLookups.delete(cacheKey)
    }
  }
}

/** Returns one normalized snapshot; ambiguous unselected results stay null. */
export async function aerodataboxStatus(
  requestedFlightNumber: string,
  requestedTravelDate: string,
  apiKey: string,
  previousSnapshot: unknown = null,
) {
  const result = await aerodataboxLookup(
    requestedFlightNumber,
    requestedTravelDate,
    apiKey,
    previousSnapshot,
  )
  return result?.kind === 'created' ? result.snapshot : null
}

/** Test isolation only; production callers should rely on normal TTL expiry. */
export function clearAeroDataBoxProviderCachesForTest() {
  responseCache.clear()
  airportCache.clear()
  inFlightLookups.clear()
  providerRequestTail = Promise.resolve()
  nextProviderRequestAt = 0
}
