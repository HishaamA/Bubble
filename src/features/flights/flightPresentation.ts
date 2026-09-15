import {
  calculateFlightProgress,
  effectiveFlightDataQuality,
  flightArrivalTime,
  flightDepartureTime,
  isFlightCancelled,
} from './flightValidation'
import type { FlightLookupChoice } from './flightStatusService'
import type { FlightStatusSnapshot, TrackedFlight } from './types'
import { projectFlightCoordinates as project } from './flightMapProjection'

/** Maps provider quality codes to compact card labels. */
export function qualityLabel(quality: FlightStatusSnapshot['dataQuality']) {
  if (quality === 'live') return 'Live'
  if (quality === 'estimated') return 'Estimated'
  return 'Scheduled'
}

/** Formats the local travel date without UTC rollover. */
export function formatDayMonth(value: string) {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${value}T12:00:00`))
}

/** Formats a provider timestamp in the relevant airport's time zone. */
export function formatTicketTime(value: string | null, timeZone: string) {
  if (!value) return null
  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(value))
}

/** Formats the last-refresh timestamp in the viewer's local time. */
export function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

/** Labels an ambiguous provider choice in its origin airport's time zone. */
export function formatChoiceDeparture(choice: FlightLookupChoice) {
  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(choice.origin.timeZone ? { timeZone: choice.origin.timeZone } : {}),
  }).format(new Date(choice.scheduledDeparture))
}

/** Derives a rounded route duration from provider timestamps. */
export function formatDuration(departure: string | null, arrival: string | null) {
  if (!departure || !arrival) return 'Duration unavailable'
  const minutes = Math.max(0, Math.round(
    (new Date(arrival).getTime() - new Date(departure).getTime()) / 60_000,
  ))
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return `${hours}h ${remainder}m`
}

/** Prefers city, then airport name, while always retaining a code fallback. */
export function airportPlace(snapshot: FlightStatusSnapshot, side: 'origin' | 'destination') {
  const airport = snapshot[side]
  return airport.city ?? airport.name ?? airport.code
}

/** Derives the values a collapsed ticket already needs, without I/O or UI state. */
export function createFlightTicketPresentation(flight: TrackedFlight, now: Date) {
  const departure = flightDepartureTime(flight.snapshot)
  const arrival = flightArrivalTime(flight.snapshot)
  const quality = effectiveFlightDataQuality(flight.snapshot, now)
  const cancelled = isFlightCancelled(flight.snapshot)
  const duration = formatDuration(departure, arrival)
  return { departure, arrival, quality, cancelled, duration }
}

/** Evaluates the route's quadratic Bézier at a normalized progress value. */
function pointOnQuadratic(
  start: { x: number; y: number },
  control: { x: number; y: number },
  end: { x: number; y: number },
  progress: number,
) {
  const inverse = 1 - progress
  return {
    x: inverse * inverse * start.x
      + 2 * inverse * progress * control.x
      + progress * progress * end.x,
    y: inverse * inverse * start.y
      + 2 * inverse * progress * control.y
      + progress * progress * end.y,
  }
}

/** Derives a wrapped map route; the view owns the cancelled-flight empty state. */
export function createFlightRoutePresentation(snapshot: FlightStatusSnapshot, now: Date) {
  const quality = effectiveFlightDataQuality(snapshot, now)
  const start = project(snapshot.origin)
  const projectedEnd = project(snapshot.destination)
  const end = { ...projectedEnd }
  if (end.x - start.x > 180) end.x -= 360
  if (end.x - start.x < -180) end.x += 360
  const control = {
    x: (start.x + end.x) / 2,
    y: Math.max(12, Math.min(start.y, end.y) - Math.min(48, Math.abs(end.x - start.x) * 0.18)),
  }
  const timelineProgress = calculateFlightProgress(snapshot, now) / 100
  const liveMarker = snapshot.position && quality === 'live'
    ? project(snapshot.position)
    : null
  if (liveMarker && liveMarker.x - start.x > 180) liveMarker.x -= 360
  if (liveMarker && liveMarker.x - start.x < -180) liveMarker.x += 360
  const marker = liveMarker
    ? liveMarker
    : pointOnQuadratic(start, control, end, timelineProgress)
  const markerDescription = liveMarker
    ? 'The airplane marker is the latest reported live position.'
    : `The airplane marker is ${quality === 'estimated' ? 'an estimated' : 'a scheduled'} timeline position, not live GPS.`
  const tangent = {
    x: 2 * (1 - timelineProgress) * (control.x - start.x)
      + 2 * timelineProgress * (end.x - control.x),
    y: 2 * (1 - timelineProgress) * (control.y - start.y)
      + 2 * timelineProgress * (end.y - control.y),
  }
  const rotation = quality === 'live'
    && typeof snapshot.position?.headingDegrees === 'number'
    ? snapshot.position.headingDegrees - 90
    : Math.atan2(tangent.y, tangent.x) * 180 / Math.PI
  const shifts = [-360, 0, 360]

  return { start, end, control, marker, markerDescription, rotation, shifts }
}
