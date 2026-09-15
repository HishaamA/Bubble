import type { TrackedFlight } from '../flights/types'
import { calculateFlightProgress, effectiveFlightDataQuality, flightArrivalTime, flightDepartureTime, formatFlightDateTime, isFlightCancelled } from '../flights/flightValidation'
import { createFlightRoutePresentation } from '../flights/flightPresentation'
import type { BubbleWidgetCard, BubbleWidgetFlightMap } from './widgetSnapshot'

const hour = 60 * 60 * 1_000
export const widgetFlightMaxLifetimeMs = 36 * hour

type FlightCard = Pick<BubbleWidgetCard,
  'kind' | 'eyebrow' | 'title' | 'subtitle' | 'badge' | 'route' | 'retainedFlight' | 'flight' | 'flightMap'>

/** Android bounds UTF-16 characters; iOS bounds UTF-8 bytes. Keep both valid. */
function compactFlightText(value: string) {
  let result = ''
  const encoder = new TextEncoder()
  for (const character of value.trim()) {
    const code = character.codePointAt(0)!
    if (code < 32 || (code >= 127 && code <= 159)) continue
    if (result.length + character.length > 40 || encoder.encode(result + character).byteLength > 64) break
    result += character
  }
  return result.trim()
}

function point(value: { x: number; y: number }) {
  return { x: Number(value.x.toFixed(4)), y: Number(value.y.toFixed(4)) }
}

/** Every row still in the tracker remains available, including completed flights. */
export function selectWidgetFlights(flights: readonly TrackedFlight[], now: Date) {
  const nowMs = now.getTime()
  const seen = new Set<string>()
  return flights.flatMap((flight) => {
    if (!flight.id || seen.has(flight.id)) return []
    seen.add(flight.id)
    const snapshot = flight.snapshot
    const departure = Date.parse(flightDepartureTime(snapshot) ?? '')
    const arrivalMs = Date.parse(flightArrivalTime(snapshot) ?? '')
    const updated = Date.parse(snapshot.updatedAt)
    const cancelled = isFlightCancelled(snapshot)
    const arrived = Boolean(snapshot.actualArrival) || /^(arrived|landed|completed)$/i.test(snapshot.status.trim())
    const quality = effectiveFlightDataQuality(snapshot, now)
    const validTimetable = [departure, arrivalMs, updated].every((time) => Number.isFinite(time) && time > 0)
      && arrivalMs > departure && arrivalMs - departure <= widgetFlightMaxLifetimeMs
    const usableCoordinates = [snapshot.origin, snapshot.destination].every(({ latitude, longitude }) => (
      Number.isFinite(latitude) && Math.abs(latitude) <= 90 && Number.isFinite(longitude) && Math.abs(longitude) <= 180
    ))
    const mode: BubbleWidgetFlightMap['mode'] = cancelled ? 'cancelled' : arrived ? 'arrived'
      : quality === 'live' ? 'live' : !validTimetable && snapshot.progressPercent === null ? 'unavailable' : quality
    const progress = cancelled || mode === 'unavailable' ? null : arrived ? 100 : calculateFlightProgress(snapshot, now)
    const route = usableCoordinates ? createFlightRoutePresentation(snapshot, now) : null
    const map: BubbleWidgetFlightMap | undefined = route ? {
      start: point(route.start), end: point(route.end), control: point(route.control),
      marker: point(arrived ? route.end : route.marker),
      rotation: Number.isFinite(route.rotation) ? Number((route.rotation % 360).toFixed(4)) : 0, mode, progress,
      advanceWithTime: (mode === 'estimated' || mode === 'scheduled') && validTimetable && snapshot.progressPercent === null,
    } : undefined
    const arrival = formatFlightDateTime(flightArrivalTime(snapshot), snapshot.destination.timeZone)
    const updatedLabel = Number.isFinite(updated)
      ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(updated)
      : 'time unavailable'
    const qualityLabel = mode === 'live' ? 'Last reported' : mode === 'arrived' ? 'Arrived'
      : mode === 'cancelled' ? 'Cancelled' : mode === 'unavailable' ? 'Progress unavailable'
        : mode === 'estimated' ? 'Estimated' : 'Scheduled'
    const arrivalLabel = arrived ? 'Arrived' : snapshot.estimatedArrival ? 'ETA' : 'Arrival'
    const card: FlightCard = {
      kind: 'flight',
      eyebrow: compactFlightText(`${flight.flightNumber} · ${flight.travelerName}`),
      title: `${snapshot.origin.code} → ${snapshot.destination.code}`,
      subtitle: `${arrivalLabel} ${arrival ? `${arrival.time} (${arrival.date})` : 'time unavailable'} · ${qualityLabel} · Updated ${updatedLabel}`,
      badge: compactFlightText(snapshot.status) || (arrived ? 'Arrived' : cancelled ? 'Cancelled' : 'Tracked'),
      route: '/journal?section=flights',
      retainedFlight: true,
      ...(validTimetable ? { flight: { departureAt: new Date(departure).toISOString(), arrivalAt: new Date(arrivalMs).toISOString(), updatedAt: new Date(updated).toISOString() } } : {}),
      ...(map ? { flightMap: map } : {}),
    }
    const rank = arrived || cancelled ? 2 : Number.isFinite(departure) && departure > nowMs ? 1 : 0
    return [{ id: flight.id, departure, arrival: arrivalMs, rank, card }]
  }).sort((left, right) => {
    const time = (Number.isFinite(left.departure) ? left.departure : 0) - (Number.isFinite(right.departure) ? right.departure : 0)
    return left.rank - right.rank || (left.rank === 2 ? -time : time) || left.id.localeCompare(right.id)
  })
}

/** Only timetable boundaries change display; there is no automatic removal deadline. */
export function widgetFlightTransitionTimes(flights: readonly TrackedFlight[]) {
  return flights.flatMap(({ snapshot }) => [Date.parse(flightDepartureTime(snapshot) ?? ''), Date.parse(flightArrivalTime(snapshot) ?? '')])
    .filter(Number.isFinite)
}
