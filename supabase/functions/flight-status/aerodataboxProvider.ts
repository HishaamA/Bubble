import { isFreshProviderPosition } from './providerHelpers.ts'

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

export type AeroDataBoxProviderErrorCode =
  | 'auth'
  | 'plan'
  | 'quota'
  | 'rate'
  | 'unavailable'
  | 'incomplete'

export class AeroDataBoxProviderError extends Error {
  readonly code: AeroDataBoxProviderErrorCode

  constructor(message: string, code: AeroDataBoxProviderErrorCode) {
    super(message)
    this.name = 'AeroDataBoxProviderError'
    this.code = code
  }
}

const providerBaseUrl = 'https://aerodatabox.p.rapidapi.com'
const providerHost = 'aerodatabox.p.rapidapi.com'
const responseCacheTtl = 60_000
const airportCacheTtl = 24 * 60 * 60 * 1000
const livePositionFreshness = 15 * 60 * 1000
const maximumResponseCacheEntries = 256
const maximumAirportCacheEntries = 512
const providerMinimumRequestInterval = 1_000
const maximumRetryAfterDelay = 5_000

const responseCache = new Map<string, {
  expiresAt: number
  value: AeroDataBoxStatusSnapshot | null
}>()
const airportCache = new Map<string, {
  expiresAt: number
  value: NormalizedAirport
}>()
const inFlightLookups = new Map<
  string,
  Promise<AeroDataBoxStatusSnapshot | null>
>()
let providerRequestTail: Promise<void> = Promise.resolve()
let nextProviderRequestAt = 0

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numeric(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function timestamp(value: unknown) {
  const candidate = text(value)
  if (!candidate) return null
  const parsed = new Date(candidate)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

function calendarDate(value: unknown) {
  const candidate = text(value)
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null
  const [year, month, day] = candidate.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? candidate
    : null
}

function normalizedFlightNumber(value: unknown) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '')
  return /^[A-Z0-9]{3,8}$/.test(normalized)
    && /[A-Z]/.test(normalized)
    && /\d/.test(normalized)
    ? normalized
    : null
}

function validTimeZone(value: unknown) {
  const candidate = text(value)
  if (!candidate) return null
  try {
    new Intl.DateTimeFormat('en', { timeZone: candidate }).format(0)
    return candidate
  } catch {
    return null
  }
}

function code(value: unknown, length: 3 | 4) {
  const candidate = text(value)?.toUpperCase()
  return candidate && new RegExp(`^[A-Z0-9]{${length}}$`).test(candidate)
    ? candidate
    : null
}

function boundedCacheSet<T>(
  cache: Map<string, { expiresAt: number; value: T }>,
  key: string,
  value: T,
  ttl: number,
  maximumEntries: number,
) {
  const now = Date.now()
  for (const [cachedKey, cached] of cache) {
    if (cached.expiresAt <= now) cache.delete(cachedKey)
  }
  while (cache.size >= maximumEntries) {
    const oldestKey = cache.keys().next().value as string | undefined
    if (!oldestKey) break
    cache.delete(oldestKey)
  }
  cache.set(key, { value, expiresAt: now + ttl })
}

function providerErrorText(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase()
  if (Array.isArray(value)) return value.map(providerErrorText).join(' ')
  const record = object(value)
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

function mappedHttpError(response: Response, body: unknown) {
  const details = providerErrorText(body)
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

function wait(delay: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delay))
}

async function waitForProviderSlot(minimumDelay = 0) {
  const delay = Math.max(
    0,
    minimumDelay,
    nextProviderRequestAt - Date.now(),
  )
  if (delay > 0) await wait(delay)
  nextProviderRequestAt = Date.now() + providerMinimumRequestInterval
}

function scheduledProviderRequest<T>(request: () => Promise<T>) {
  const scheduled = providerRequestTail.then(request)
  providerRequestTail = scheduled.then(
    () => undefined,
    () => undefined,
  )
  return scheduled
}

function retryAfterDelay(response: Response) {
  const header = text(response.headers.get('retry-after'))
  let requestedDelay = providerMinimumRequestInterval
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) {
      requestedDelay = seconds * 1_000
    } else {
      const retryAt = new Date(header).getTime()
      if (Number.isFinite(retryAt)) requestedDelay = retryAt - Date.now()
    }
  }
  return Math.min(
    maximumRetryAfterDelay,
    Math.max(providerMinimumRequestInterval, requestedDelay),
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
  let body: unknown = null
  if (response.status !== 204) {
    try {
      body = await response.json()
    } catch {
      // Keep provider HTML and malformed error bodies away from the client.
    }
  }
  return { response, body }
}

function providerAttemptValue(attempt: {
  response: Response
  body: unknown
}) {
  if (attempt.response.status === 204) return null
  if (!attempt.response.ok) {
    throw mappedHttpError(attempt.response, attempt.body)
  }
  const { body } = attempt
  if (body === null) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox returned an incomplete response.',
      'incomplete',
    )
  }
  return body
}

async function providerRequest(path: string, apiKey: string) {
  return scheduledProviderRequest(async () => {
    await waitForProviderSlot()
    let attempt = await providerAttempt(path, apiKey)
    if (attempt.response.status === 429) {
      const error = mappedHttpError(attempt.response, attempt.body)
      if (error.code === 'rate') {
        await waitForProviderSlot(retryAfterDelay(attempt.response))
        attempt = await providerAttempt(path, apiKey)
      }
    }
    return providerAttemptValue(attempt)
  })
}

function localMovementDate(movement: JsonObject) {
  const scheduled = object(movement.scheduledTime)
  const local = text(scheduled?.local)
  if (!local || local.length < 10) return null
  return calendarDate(local.slice(0, 10))
}

function canonicalFlightSuffix(value: string) {
  const match = /^(\d+)([A-Z]?)$/.exec(value)
  if (!match) return null
  return `${match[1].replace(/^0+(?=\d)/, '')}${match[2]}`
}

function airlineDesignators(row: JsonObject) {
  const airline = object(row.airline)
  return [
    text(airline?.iata)?.toUpperCase(),
    text(airline?.icao)?.toUpperCase(),
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
  const returnedFlightNumber = normalizedFlightNumber(row.number)
  if (!returnedFlightNumber) return false
  if (returnedFlightNumber === requestedFlightNumber) return true

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

function rowMatchesTravelDate(row: JsonObject, travelDate: string) {
  const departure = object(row.departure)
  const arrival = object(row.arrival)
  return departure !== null && localMovementDate(departure) === travelDate
    || arrival !== null && localMovementDate(arrival) === travelDate
}

function candidateProviderFlightId(row: JsonObject) {
  const providerNumber = normalizedFlightNumber(row.number)
  const scheduledDeparture = movementTimestamp(
    object(row.departure),
    'scheduledTime',
  )
  return providerNumber && scheduledDeparture
    ? `${providerNumber}:${scheduledDeparture}`
    : providerNumber
}

function matchingFlightRow(
  response: unknown,
  flightNumber: string,
  travelDate: string,
  previousSnapshot: unknown,
) {
  if (!Array.isArray(response)) return null
  const datedRows = response
    .map(object)
    .filter((row): row is JsonObject => row !== null)
    .filter((row) => rowMatchesTravelDate(row, travelDate))
  const exactMatches = datedRows.filter((row) =>
    equivalentFlightNumber(row, flightNumber),
  )
  const operatorMatches = datedRows.filter((row) =>
    text(row.codeshareStatus)?.toLowerCase() === 'isoperator',
  )
  const matches = exactMatches.length > 0 ? exactMatches : operatorMatches
  if (matches.length === 0) return null

  const previous = object(previousSnapshot)
  const previousProviderFlightId = text(previous?.providerFlightId)
  if (previousProviderFlightId) {
    const previousMatch = matches.find((row) =>
      candidateProviderFlightId(row) === previousProviderFlightId,
    )
    if (previousMatch) return previousMatch
  }

  const uniqueMatches = new Map<string, JsonObject>()
  for (const row of matches) {
    const identity = candidateProviderFlightId(row)
    if (identity) uniqueMatches.set(identity, row)
  }
  if (uniqueMatches.size !== 1) return null
  return uniqueMatches.values().next().value as JsonObject
}

function movementTimestamp(
  movement: JsonObject | null,
  field: 'scheduledTime' | 'revisedTime' | 'predictedTime' | 'runwayTime',
) {
  const value = object(movement?.[field])
  return timestamp(value?.utc) ?? timestamp(value?.local)
}

function embeddedAirportIdentity(value: JsonObject) {
  const iata = code(value.iata, 3)
  const icao = code(value.icao, 4)
  if (!iata && !icao) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox omitted an airport identifier.',
      'incomplete',
    )
  }
  return {
    code: iata ?? icao as string,
    kind: iata ? 'Iata' as const : 'Icao' as const,
    iata,
    icao,
  }
}

function normalizedAirport(
  value: JsonObject,
  expectedCode: string,
): NormalizedAirport | null {
  const location = object(value.location)
  const latitude = numeric(location?.lat)
  const longitude = numeric(location?.lon)
  const timeZone = validTimeZone(value.timeZone)
  const candidateIata = code(value.iata, 3)
  const candidateIcao = code(value.icao, 4)
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
    name: text(value.name) ?? text(value.shortName),
    city: text(value.municipalityName),
    latitude,
    longitude,
    timeZone,
  }
}

function previousAirport(value: unknown, expectedCode: string) {
  const previous = object(value)
  if (text(previous?.code)?.toUpperCase() !== expectedCode) return null
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
  const movement = object(movementValue)
  const embedded = object(movement?.airport)
  if (!embedded) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox omitted airport details.',
      'incomplete',
    )
  }
  const identity = embeddedAirportIdentity(embedded)
  const completeEmbedded = normalizedAirport(embedded, identity.code)
  if (completeEmbedded) return completeEmbedded

  const fromPrevious = previousAirport(previousValue, identity.code)
  if (fromPrevious) {
    return {
      ...fromPrevious,
      name: text(embedded.name) ?? text(embedded.shortName) ?? fromPrevious.name,
      city: text(embedded.municipalityName) ?? fromPrevious.city,
      timeZone: validTimeZone(embedded.timeZone) ?? fromPrevious.timeZone,
    }
  }

  const cacheKey = `aerodatabox:airport:${identity.kind}:${identity.code}`
  const cached = airportCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const response = await providerRequest(
    `/airports/${identity.kind}/${encodeURIComponent(identity.code)}`,
    apiKey,
  )
  const fallback = object(response)
  const normalized = fallback
    ? normalizedAirport(fallback, identity.code)
    : null
  if (!normalized) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox returned incomplete airport details.',
      'incomplete',
    )
  }
  const merged = {
    ...normalized,
    name: text(embedded.name) ?? text(embedded.shortName) ?? normalized.name,
    city: text(embedded.municipalityName) ?? normalized.city,
    timeZone: validTimeZone(embedded.timeZone) ?? normalized.timeZone,
  }
  boundedCacheSet(
    airportCache,
    cacheKey,
    merged,
    airportCacheTtl,
    maximumAirportCacheEntries,
  )
  return merged
}

function normalizedStatus(value: unknown) {
  const raw = text(value) ?? 'Unknown'
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
  }
}

function normalizedPosition(value: unknown): NormalizedPosition | null {
  const location = object(value)
  const latitude = numeric(location?.lat)
  const longitude = numeric(location?.lon)
  const altitude = object(location?.altitude)
  const track = object(location?.trueTrack)
  const altitudeFeet = numeric(altitude?.feet)
  const heading = numeric(track?.deg)
  const recordedAt = timestamp(location?.reportedAtUtc)
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
    && quality.some((item) => text(item)?.toLowerCase() === 'live')
}

function latestTimestamp(...values: Array<string | null | undefined>) {
  let latest: { timestamp: number; value: string } | null = null
  for (const value of values) {
    if (!value) continue
    const parsed = new Date(value).getTime()
    if (!Number.isFinite(parsed)) continue
    if (!latest || parsed > latest.timestamp) {
      latest = { timestamp: parsed, value: new Date(parsed).toISOString() }
    }
  }
  return latest?.value ?? null
}

async function buildNormalizedStatus(
  flightNumber: string,
  travelDate: string,
  apiKey: string,
  previousSnapshot: unknown,
): Promise<AeroDataBoxStatusSnapshot | null> {
  const response = await providerRequest(
    `/flights/number/${encodeURIComponent(flightNumber)}/${travelDate}`
      + '?dateLocalRole=Both&withLocation=true&withAircraftImage=false',
    apiKey,
  )
  if (response === null) return null
  const selected = matchingFlightRow(
    response,
    flightNumber,
    travelDate,
    previousSnapshot,
  )
  if (!selected) return null
  const providerFlightNumber = normalizedFlightNumber(selected.number)
  if (!providerFlightNumber) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox omitted the operating flight number.',
      'incomplete',
    )
  }

  const departure = object(selected.departure)
  const arrival = object(selected.arrival)
  if (!departure || !arrival) {
    throw new AeroDataBoxProviderError(
      'AeroDataBox omitted flight movement details.',
      'incomplete',
    )
  }
  const previous = object(previousSnapshot)
  const [origin, destination] = await Promise.all([
    airportDetails(departure, apiKey, previous?.origin),
    airportDetails(arrival, apiKey, previous?.destination),
  ])
  const status = normalizedStatus(selected.status)
  const departureCompleted = new Set([
    'departed',
    'enroute',
    'approaching',
    'arrived',
    'diverted',
  ]).has(status.token)
  const arrivalCompleted = new Set(['arrived']).has(status.token)
  const departureTimes = movementTimes(departure, departureCompleted)
  const arrivalTimes = movementTimes(arrival, arrivalCompleted)
  const position = normalizedPosition(selected.location)
  const freshPosition = isFreshProviderPosition(
    position,
    Date.now(),
    livePositionFreshness,
  )
  const operationalStatus = new Set([
    'checkin',
    'boarding',
    'gateclosed',
    'departed',
    'enroute',
    'approaching',
    'delayed',
  ]).has(status.token)
  const liveMovement = operationalStatus
    && (movementHasLiveQuality(departure) || movementHasLiveQuality(arrival))
  const hasEstimate = departureTimes.estimated !== null
    || arrivalTimes.estimated !== null
    || movementTimestamp(departure, 'revisedTime') !== null
    || movementTimestamp(departure, 'predictedTime') !== null
    || movementTimestamp(departure, 'runwayTime') !== null
    || movementTimestamp(arrival, 'revisedTime') !== null
    || movementTimestamp(arrival, 'predictedTime') !== null
    || movementTimestamp(arrival, 'runwayTime') !== null
    || movementHasLiveQuality(departure)
    || movementHasLiveQuality(arrival)
  const dataQuality = freshPosition || liveMovement
    ? 'live'
    : hasEstimate
      ? 'estimated'
      : 'scheduled'
  const updatedAt = latestTimestamp(
    position?.recordedAt,
    timestamp(selected.lastUpdatedUtc),
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

export async function aerodataboxStatus(
  requestedFlightNumber: string,
  requestedTravelDate: string,
  apiKey: string,
  previousSnapshot: unknown = null,
) {
  const flightNumber = normalizedFlightNumber(requestedFlightNumber)
  const travelDate = calendarDate(requestedTravelDate)
  if (!flightNumber || !travelDate) {
    throw new AeroDataBoxProviderError(
      'The flight lookup identity is invalid.',
      'incomplete',
    )
  }
  const cacheKey = `aerodatabox:status:${flightNumber}:${travelDate}`
  const cached = responseCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = inFlightLookups.get(cacheKey)
  if (existing) return existing

  const lookup = buildNormalizedStatus(
    flightNumber,
    travelDate,
    apiKey,
    previousSnapshot,
  )
  inFlightLookups.set(cacheKey, lookup)
  try {
    const value = await lookup
    boundedCacheSet(
      responseCache,
      cacheKey,
      value,
      responseCacheTtl,
      maximumResponseCacheEntries,
    )
    return value
  } finally {
    if (inFlightLookups.get(cacheKey) === lookup) {
      inFlightLookups.delete(cacheKey)
    }
  }
}

/** Test isolation only; production callers should rely on normal TTL expiry. */
export function clearAeroDataBoxProviderCachesForTest() {
  responseCache.clear()
  airportCache.clear()
  inFlightLookups.clear()
  providerRequestTail = Promise.resolve()
  nextProviderRequestAt = 0
}
