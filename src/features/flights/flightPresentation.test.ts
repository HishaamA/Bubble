import { describe, expect, it } from 'vitest'
import {
  airportPlace,
  createFlightRoutePresentation,
  createFlightTicketPresentation,
  formatChoiceDeparture,
  formatDayMonth,
  formatDuration,
  formatTicketTime,
  qualityLabel,
} from './flightPresentation'
import type { FlightLookupChoice } from './flightStatusService'
import type { FlightStatusSnapshot, TrackedFlight } from './types'

const now = new Date('2026-09-10T12:00:00.000Z')
const snapshot: FlightStatusSnapshot = {
  provider: 'aerodatabox',
  providerFlightId: 'flight-1',
  flightNumber: 'EK202',
  status: 'In flight',
  dataQuality: 'estimated',
  origin: {
    code: 'AAA', name: 'Origin airport', city: 'Origin city', timeZone: 'America/Los_Angeles',
    latitude: 0, longitude: 170,
  },
  destination: {
    code: 'BBB', name: 'Destination airport', city: null, timeZone: 'Asia/Dubai',
    latitude: 0, longitude: -170,
  },
  scheduledDeparture: '2026-09-10T10:00:00.000Z',
  estimatedDeparture: null,
  actualDeparture: null,
  scheduledArrival: '2026-09-10T14:00:00.000Z',
  estimatedArrival: '2026-09-10T14:00:00.000Z',
  actualArrival: null,
  progressPercent: null,
  position: null,
  updatedAt: now.toISOString(),
}

function flight(overrides: Partial<FlightStatusSnapshot> = {}): TrackedFlight {
  return {
    id: 'flight-1',
    travelerName: 'Family trip',
    flightNumber: 'EK202',
    travelDate: '2026-09-10',
    createdAt: now.toISOString(),
    notificationEnabled: false,
    synced: true,
    snapshot: { ...snapshot, ...overrides },
  }
}

describe('flight presentation labels', () => {
  it.each([['live', 'Live'], ['estimated', 'Estimated'], ['scheduled', 'Scheduled']] as const)(
    'keeps the %s quality label',
    (quality, label) => expect(qualityLabel(quality)).toBe(label),
  )

  it('formats ticket times in each airport zone and keeps missing times absent', () => {
    expect(formatTicketTime('2026-09-10T00:30:00.000Z', 'America/Los_Angeles')).toBe('17:30')
    expect(formatTicketTime('2026-09-10T00:30:00.000Z', 'Asia/Dubai')).toBe('04:30')
    expect(formatTicketTime(null, 'Asia/Dubai')).toBeNull()
    expect(formatDayMonth('2026-09-10')).toBe('Sep 10')
  })

  it('labels ambiguous departures by their origin date, not the UTC date', () => {
    const choice: FlightLookupChoice = {
      providerFlightId: 'choice-1',
      flightNumber: 'EK202',
      operatingFlightNumber: null,
      origin: snapshot.origin,
      destination: snapshot.destination,
      scheduledDeparture: '2026-09-10T00:30:00.000Z',
      scheduledArrival: snapshot.scheduledArrival,
    }
    expect(formatChoiceDeparture(choice)).toContain('Sep 9')
    expect(formatChoiceDeparture(choice)).toContain('5:30 PM')
  })

  it.each([
    [null, '2026-09-10T14:00:00.000Z', 'Duration unavailable'],
    ['2026-09-10T10:00:00.000Z', null, 'Duration unavailable'],
    ['2026-09-10T10:00:00.000Z', '2026-09-10T11:25:31.000Z', '1h 26m'],
    ['2026-09-10T14:00:00.000Z', '2026-09-10T10:00:00.000Z', '0h 0m'],
  ])('preserves rounded and missing duration handling', (departure, arrival, expected) => {
    expect(formatDuration(departure, arrival)).toBe(expected)
  })

  it('preserves city, airport name, and code fallback order without rewriting empty labels', () => {
    expect(airportPlace(snapshot, 'origin')).toBe('Origin city')
    expect(airportPlace(snapshot, 'destination')).toBe('Destination airport')
    expect(airportPlace({ ...snapshot, origin: { ...snapshot.origin, city: null, name: null } }, 'origin')).toBe('AAA')
    expect(airportPlace({ ...snapshot, origin: { ...snapshot.origin, city: '' } }, 'origin')).toBe('')
  })
})

describe('flight ticket view model', () => {
  it('preserves actual-over-estimated timestamps and leaves its source untouched', () => {
    const tracked = flight({
      actualDeparture: '2026-09-10T10:15:00.000Z',
      estimatedDeparture: '2026-09-10T10:05:00.000Z',
      actualArrival: '2026-09-10T14:45:00.000Z',
    })
    const original = structuredClone(tracked)
    expect(createFlightTicketPresentation(tracked, now)).toEqual({
      departure: '2026-09-10T10:15:00.000Z',
      arrival: '2026-09-10T14:45:00.000Z',
      quality: 'estimated', cancelled: false, duration: '4h 30m',
    })
    expect(tracked).toEqual(original)
  })

  it('exposes cancellation without changing the cached provider timestamps', () => {
    const tracked = flight({ status: ' Canceled ' })
    expect(createFlightTicketPresentation(tracked, now)).toMatchObject({
      cancelled: true,
      departure: snapshot.scheduledDeparture,
      arrival: snapshot.estimatedArrival,
    })
  })
})

describe('flight route view model', () => {
  it.each([[170, -170, 350, 370, 360], [-170, 170, 10, -10, 0]])(
    'wraps the %s° to %s° route across the nearby dateline',
    (from, to, expectedStart, expectedEnd, expectedMarker) => {
      const route = createFlightRoutePresentation({
        ...snapshot,
        origin: { ...snapshot.origin, longitude: from },
        destination: { ...snapshot.destination, longitude: to },
      }, now)
      expect(route.start.x).toBe(expectedStart)
      expect(route.end.x).toBe(expectedEnd)
      expect(route.marker.x).toBe(expectedMarker)
      expect(route.shifts).toEqual([-360, 0, 360])
      expect(route.markerDescription).toContain('estimated timeline position, not live GPS')
    },
  )

  it('uses a fresh live position and heading without mutating provider coordinates', () => {
    const live = {
      ...snapshot,
      dataQuality: 'live' as const,
      position: { latitude: 20, longitude: -179, altitudeFeet: 35_000, headingDegrees: 135, recordedAt: now.toISOString() },
    }
    const original = structuredClone(live)
    const route = createFlightRoutePresentation(live, now)
    expect(route.marker.x).toBe(361)
    expect(route.rotation).toBe(45)
    expect(route.markerDescription).toContain('latest reported live position')
    expect(live).toEqual(original)
  })

  it('downgrades stale coordinates to the same estimated timeline used by the ticket', () => {
    const tracked = flight({
      dataQuality: 'live',
      position: { latitude: 20, longitude: -179, altitudeFeet: null, headingDegrees: 135, recordedAt: '2026-09-10T11:30:00.000Z' },
    })
    expect(createFlightTicketPresentation(tracked, now).quality).toBe('estimated')
    const route = createFlightRoutePresentation(tracked.snapshot, now)
    expect(route.marker.x).toBe(360)
    expect(route.rotation).toBe(0)
    expect(route.markerDescription).toContain('estimated timeline position, not live GPS')
  })
})
