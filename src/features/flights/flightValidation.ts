import type { FlightFormInput, FlightStatusSnapshot } from './types'

export const ticketNumberMessage =
  'A 13-digit ticket number cannot be resolved by public flight trackers. Enter the airline flight number (for example EK202) and travel date instead. Ticket numbers are never stored.'

export type ValidatedFlightForm = {
  travelerName: string
  flightNumber: string
  travelDate: string
}

export type FlightFormValidation =
  | { valid: true; value: ValidatedFlightForm }
  | { valid: false; field: keyof FlightFormInput; message: string }

/** Canonicalizes common airline-number spacing and punctuation. */
export function normalizeFlightNumber(value: string) {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '')
}

/** Distinguishes unsupported 13-digit ticket numbers from flight numbers. */
export function looksLikeTicketNumber(value: string) {
  return /^\d{13}$/.test(value.trim().replace(/[\s-]+/g, ''))
}

/** Calendar-day input is interpreted in the device's local time zone. */
export function localCalendarDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Shifts a local calendar date without introducing UTC or DST drift. */
export function shiftLocalCalendarDate(date: Date, days: number) {
  const shifted = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
    12,
  )
  return localCalendarDate(shifted)
}

/** Parses a real local calendar date while rejecting rollover such as Feb 31. */
function parseIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day, 12)
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return null
  return date
}

/** Produces a DST-independent day number for range comparisons. */
function localCalendarDay(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
}

/** Validates and canonicalizes user input before any provider request. */
export function validateFlightForm(
  input: FlightFormInput,
  now = new Date(),
): FlightFormValidation {
  const travelerName = input.travelerName.trim().replace(/\s+/g, ' ')
  if (!travelerName || travelerName.length > 60) {
    return {
      valid: false,
      field: 'travelerName',
      message: 'Enter the traveler’s name using 60 characters or fewer.',
    }
  }

  if (looksLikeTicketNumber(input.flightNumber)) {
    return { valid: false, field: 'flightNumber', message: ticketNumberMessage }
  }

  const flightNumber = normalizeFlightNumber(input.flightNumber)
  if (
    !/^[A-Z0-9]{3,8}$/.test(flightNumber)
    || !/[A-Z]/.test(flightNumber)
    || !/\d/.test(flightNumber)
  ) {
    return {
      valid: false,
      field: 'flightNumber',
      message: 'Enter an airline flight number, such as EK202 or UAE202.',
    }
  }

  const travelDate = input.travelDate.trim()
  const parsedDate = parseIsoDate(travelDate)
  if (!parsedDate) {
    return {
      valid: false,
      field: 'travelDate',
      message: 'Choose a valid travel date.',
    }
  }

  const dayDifference = (
    localCalendarDay(parsedDate) - localCalendarDay(now)
  ) / 86_400_000
  if (dayDifference < -1 || dayDifference > 365) {
    return {
      valid: false,
      field: 'travelDate',
      message: 'Choose a flight from yesterday through the next 12 months.',
    }
  }

  return {
    valid: true,
    value: { travelerName, flightNumber, travelDate },
  }
}

/** Converts an optional timestamp into a finite number for progress arithmetic. */
function timestamp(value: string | null) {
  if (!value) return null
  const result = new Date(value).getTime()
  return Number.isFinite(result) ? result : null
}

/** Derives bounded journey progress when the provider omits a live percentage. */
export function calculateFlightProgress(
  snapshot: FlightStatusSnapshot,
  now = new Date(),
) {
  if (isFlightCancelled(snapshot)) return 0
  if (snapshot.actualArrival) return 100
  if (
    typeof snapshot.progressPercent === 'number'
    && Number.isFinite(snapshot.progressPercent)
  ) {
    return Math.round(Math.min(100, Math.max(0, snapshot.progressPercent)))
  }

  const departure = timestamp(
    snapshot.actualDeparture
      ?? snapshot.estimatedDeparture
      ?? snapshot.scheduledDeparture,
  )
  const arrival = timestamp(
    snapshot.estimatedArrival ?? snapshot.scheduledArrival,
  )
  if (departure === null || arrival === null || arrival <= departure) return 0
  return Math.round(
    Math.min(100, Math.max(0, (now.getTime() - departure) / (arrival - departure) * 100)),
  )
}

/** Returns the best available arrival timestamp in actual-to-scheduled order. */
export function flightArrivalTime(snapshot: FlightStatusSnapshot) {
  return snapshot.actualArrival
    ?? snapshot.estimatedArrival
    ?? snapshot.scheduledArrival
}

/** Returns the best available departure timestamp in actual-to-scheduled order. */
export function flightDepartureTime(snapshot: FlightStatusSnapshot) {
  return snapshot.actualDeparture
    ?? snapshot.estimatedDeparture
    ?? snapshot.scheduledDeparture
}

export const livePositionFreshnessMs = 15 * 60 * 1000

/** Downgrades stale live positions without discarding useful ETA information. */
export function effectiveFlightDataQuality(
  snapshot: FlightStatusSnapshot,
  now = new Date(),
) {
  if (snapshot.dataQuality !== 'live') return snapshot.dataQuality
  const recordedAt = snapshot.position?.recordedAt
  const timestamp = recordedAt ? new Date(recordedAt).getTime() : Number.NaN
  if (
    Number.isFinite(timestamp)
    && timestamp >= now.getTime() - livePositionFreshnessMs
    && timestamp <= now.getTime() + 2 * 60 * 1000
  ) return 'live' as const
  return snapshot.estimatedArrival || snapshot.estimatedDeparture
    ? 'estimated' as const
    : 'scheduled' as const
}

/** Treats arrival and cancellation as terminal tracking states. */
export function isFlightComplete(snapshot: FlightStatusSnapshot) {
  const status = snapshot.status.trim().toLowerCase()
  return Boolean(snapshot.actualArrival)
    || status === 'arrived'
    || status === 'cancelled'
    || status === 'canceled'
}

/** Normalizes provider spelling before checking cancellation state. */
export function isFlightCancelled(snapshot: FlightStatusSnapshot) {
  const status = snapshot.status.trim().toLowerCase()
  return status === 'cancelled' || status === 'canceled'
}

export type FormattedFlightDateTime = {
  time: string
  date: string
  timeZone: string
}

/** Formats a flight timestamp in the airport's IANA time zone. */
export function formatFlightDateTime(
  value: string | null,
  timeZone: string,
): FormattedFlightDateTime | null {
  if (!value) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  try {
    const time = new Intl.DateTimeFormat('en', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date)
    const dateLabel = new Intl.DateTimeFormat('en', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(date)
    return { time, date: dateLabel, timeZone }
  } catch {
    return null
  }
}
