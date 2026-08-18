export type ProviderJsonObject = Record<string, unknown>

export type ProviderPosition = {
  latitude: number
  longitude: number
  altitudeFeet: number | null
  headingDegrees: number | null
  recordedAt: string
}

const defaultAllowedOrigins = new Set([
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

/** Capacitor Android uses https://localhost; iOS uses capacitor://localhost. */
export function isAllowedFlightTrackerOrigin(
  origin: string | null,
  configuredOrigins: string | null = null,
) {
  if (!origin) return true
  if (defaultAllowedOrigins.has(origin)) return true
  return configuredOrigins
    ?.split(',')
    .some((configured) => configured.trim() === origin) ?? false
}

/**
 * AeroAPI's active-flight endpoint rejects any query boundary outside its
 * rolling ten-days-past / two-days-future window. Only use it when the full
 * origin-date search window fits; schedules remain the safe fallback.
 */
export function activeFlightLookupRange(
  travelDate: string,
  now = new Date(),
) {
  const travelDay = isoCalendarDay(travelDate)
  if (travelDay === null || !Number.isFinite(now.getTime())) return null
  const start = travelDay - 18 * 60 * 60 * 1000
  const end = travelDay + (24 + 18) * 60 * 60 * 1000 - 1
  const earliest = now.getTime() - 10 * 24 * 60 * 60 * 1000
  const latest = now.getTime() + 2 * 24 * 60 * 60 * 1000
  if (start < earliest || end > latest) return null
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  }
}

function isoCalendarDay(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null
  }
  const [year, month, day] = value.split('-').map(Number)
  const timestamp = Date.UTC(year, month - 1, day)
  const date = new Date(timestamp)
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? timestamp
    : null
}

/** Accept the device-local calendar day, bounded to every real-world UTC offset. */
export function validClientCalendarDate(value: unknown, now = new Date()) {
  const candidate = isoCalendarDay(value)
  if (candidate === null) return null
  const serverCalendarDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  )
  return Math.abs((candidate - serverCalendarDay) / 86_400_000) <= 1
    ? value as string
    : null
}

/** Travel-date limits are measured from the explicit device-local calendar day. */
export function validTravelDateForCalendar(
  value: unknown,
  clientCalendarDate: string,
) {
  const travelDay = isoCalendarDay(value)
  const clientDay = isoCalendarDay(clientCalendarDate)
  if (travelDay === null || clientDay === null) return null
  const difference = (travelDay - clientDay) / 86_400_000
  return difference >= -1 && difference <= 365 ? value as string : null
}

function object(value: unknown): ProviderJsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ProviderJsonObject
    : null
}

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function timestamp(value: unknown) {
  let date: Date
  if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(value < 10_000_000_000 ? value * 1_000 : value)
  } else if (typeof value === 'string' && value.trim()) {
    date = new Date(value)
  } else {
    return null
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** AeroAPI uses `flights` for active results and `scheduled` for timetable results. */
export function providerFlightRows(value: unknown) {
  const response = object(value)
  if (!response) return []
  const source = Array.isArray(response.flights)
    ? response.flights
    : Array.isArray(response.data)
      ? response.data
      : Array.isArray(response.scheduled)
        ? response.scheduled
        : Array.isArray(response.schedules)
          ? response.schedules
          : []
  return source.map(object).filter(
    (item): item is ProviderJsonObject => item !== null,
  )
}

/** `/flights/{id}/position` nests the latest report under `last_position`. */
export function parseLastPositionResponse(value: unknown): ProviderPosition | null {
  const response = object(value)
  const position = object(response?.last_position) ?? response
  if (!position) return null
  const latitude = number(position.latitude)
  const longitude = number(position.longitude)
  const recordedAt = timestamp(position.timestamp)
    ?? timestamp(position.recorded_at)
    ?? timestamp(position.last_updated)
  if (
    latitude === null
    || latitude < -90
    || latitude > 90
    || longitude === null
    || longitude < -180
    || longitude > 180
    || !recordedAt
  ) return null
  const altitude = number(position.altitude)
  const heading = number(position.heading)
  return {
    latitude,
    longitude,
    altitudeFeet: altitude === null ? null : altitude * 100,
    headingDegrees: heading === null ? null : ((heading % 360) + 360) % 360,
    recordedAt,
  }
}

export function isFreshProviderPosition(
  position: ProviderPosition | null,
  nowMs = Date.now(),
  freshnessMs = 15 * 60 * 1000,
) {
  if (!position) return false
  const recordedAt = new Date(position.recordedAt).getTime()
  return Number.isFinite(recordedAt)
    && recordedAt >= nowMs - freshnessMs
    && recordedAt <= nowMs + 2 * 60 * 1000
}
