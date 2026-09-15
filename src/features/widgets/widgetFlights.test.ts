import { describe, expect, it } from 'vitest'
import type { TrackedFlight, FlightStatusSnapshot } from '../flights/types'
import { selectWidgetFlights, widgetFlightTransitionTimes } from './widgetFlights'
import { selectBubbleWidgetTimeline } from './widgetSnapshot'
import { createFlightRoutePresentation } from '../flights/flightPresentation'

const now = new Date('2026-09-14T12:00:00Z')
function flight(overrides: Partial<FlightStatusSnapshot> = {}, id = 'one'): TrackedFlight {
  return {
    id, travelerName: 'Mum', flightNumber: 'EK202', travelDate: '2026-09-14',
    createdAt: now.toISOString(), notificationEnabled: false, synced: true,
    snapshot: {
      provider: 'aerodatabox', providerFlightId: 'provider-id', flightNumber: 'EK202',
      status: 'En Route', dataQuality: 'estimated',
      origin: { code: 'JFK', name: null, city: 'New York', latitude: 40.64, longitude: -73.78, timeZone: 'America/New_York' },
      destination: { code: 'DXB', name: null, city: 'Dubai', latitude: 25.25, longitude: 55.36, timeZone: 'Asia/Dubai' },
      scheduledDeparture: '2026-09-14T06:00:00Z', estimatedDeparture: null, actualDeparture: '2026-09-14T06:00:00Z',
      scheduledArrival: '2026-09-14T18:00:00Z', estimatedArrival: '2026-09-14T18:30:00Z', actualArrival: null,
      progressPercent: 40, position: null, updatedAt: now.toISOString(), ...overrides,
    },
  }
}

describe('retained flight widget selection', () => {
  it('shows a route, destination-local ETA, traveler and honest cached timetable', () => {
    const [selected] = selectWidgetFlights([flight()], now)
    expect(selected.card).toMatchObject({
      kind: 'flight', title: 'JFK → DXB', eyebrow: 'EK202 · Mum', badge: 'En Route', route: '/journal?section=flights',
      flight: { departureAt: '2026-09-14T06:00:00.000Z', arrivalAt: '2026-09-14T18:30:00.000Z', updatedAt: now.toISOString() },
    })
    expect(selected.card.subtitle).toMatch(/ETA 10:30 PM GMT\+4 .*Estimated · Updated/)
    expect(JSON.stringify(selected)).not.toMatch(/provider-id|progressPercent/)
  })
  it.each(['Arrived', 'Landed', 'Completed', 'Cancelled', 'Canceled'])('retains %s flights with their real status', (status) => {
    const [{ card }] = selectWidgetFlights([flight({ status })], now)
    expect(card.badge).toBe(status)
    expect(card.retainedFlight).toBe(true)
    expect(card.flightMap?.mode).toBe(/cancel/i.test(status) ? 'cancelled' : 'arrived')
    expect(card.flightMap?.progress).toBe(/cancel/i.test(status) ? null : 100)
  })
  it('places arrived flights at their destination and retains them until removal', () => {
    const [{ card }] = selectWidgetFlights([flight({ actualArrival: now.toISOString() })], now)
    expect(card.flightMap?.mode).toBe('arrived')
    expect(card.flightMap?.marker).toEqual(card.flightMap?.end)
    expect(card.flightMap?.advanceWithTime).toBe(false)
    expect(selectWidgetFlights([], now)).toEqual([])
  })
  it('does not claim arrival or remove a flight based solely on elapsed time', () => {
    expect(selectWidgetFlights([flight()], new Date('2026-09-14T19:00:00Z'))[0].card.badge).toBe('En Route')
    expect(selectWidgetFlights([flight()], new Date('2027-09-14T20:30:00Z'))).toHaveLength(1)
  })
  it('keeps stale flights and safely drops unusable timetable metadata, not the card', () => {
    expect(selectWidgetFlights([flight({ updatedAt: '2026-09-13T11:00:00Z' })], now)).toHaveLength(1)
    expect(selectWidgetFlights([flight({ updatedAt: '2026-09-15T12:00:00Z' })], now)).toHaveLength(1)
    expect(selectWidgetFlights([flight({ actualDeparture: '2026-09-14T19:00:00Z' })], now)[0].card.flight).toBeUndefined()
    expect(selectWidgetFlights([flight({ actualDeparture: 'invalid' })], now)[0].card.flight).toBeUndefined()
  })
  it('includes every future departure and prioritizes flights already underway', () => {
    const tomorrow = flight({ actualDeparture: null, scheduledDeparture: '2026-09-15T12:00:00Z', estimatedArrival: '2026-09-15T18:00:00Z' }, 'tomorrow')
    const later = flight({ actualDeparture: null, scheduledDeparture: '2026-09-15T12:01:00Z', estimatedArrival: '2026-09-15T18:00:00Z' }, 'later')
    expect(selectWidgetFlights([tomorrow, later, flight()], now).map(({ id }) => id)).toEqual(['one', 'tomorrow', 'later'])
  })
  it('keeps a card when a provider uses an epoch sentinel update timestamp', () => {
    const [{ card }] = selectWidgetFlights([flight({ updatedAt: '1970-01-01T00:00:00Z' })], now)
    expect(card.retainedFlight).toBe(true)
    expect(card.flight).toBeUndefined()
  })
  it.each([451, Number.POSITIVE_INFINITY])('normalizes unusual provider headings (%s) before native publication', (headingDegrees) => {
    const [{ card }] = selectWidgetFlights([flight({ dataQuality: 'live', position: { latitude: 40, longitude: 20, headingDegrees, altitudeFeet: null, recordedAt: now.toISOString() } })], now)
    expect(Number.isFinite(card.flightMap?.rotation)).toBe(true)
    expect(Math.abs(card.flightMap!.rotation)).toBeLessThan(360)
  })
  it('deduplicates rows and bounds metadata', () => {
    const longName = { ...flight(), travelerName: 'A'.repeat(100) }
    const selected = selectWidgetFlights([longName, longName], now)
    expect(selected).toHaveLength(1)
    expect(selected[0].card.eyebrow.length).toBeLessThanOrEqual(40)
    expect(selected[0].card.retainedFlight).toBe(true)
    expect(selected[0].card).not.toHaveProperty('expiresAt')
  })
  it('keeps Arabic, CJK and emoji names within both native text contracts', () => {
    for (const travelerName of ['محمد'.repeat(20), '家族'.repeat(40), '👩🏽'.repeat(30)]) {
      const [{ card }] = selectWidgetFlights([{ ...flight({ status: '空中'.repeat(40) }), travelerName }], now)
      for (const text of [card.eyebrow, card.badge!]) {
        expect(text.length).toBeLessThanOrEqual(40)
        expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(64)
      }
    }
  })
  it('supports an overnight journey without declaring it completed', () => {
    const overnight = flight({ scheduledDeparture: '2026-09-14T22:00:00Z', actualDeparture: null, estimatedArrival: '2026-09-15T08:00:00Z' })
    expect(selectWidgetFlights([overnight], new Date('2026-09-15T01:00:00Z'))).toHaveLength(1)
  })
  it('supplies timetable transitions but no expiry transition', () => {
    expect(widgetFlightTransitionTimes([flight()])).toEqual([
      Date.parse('2026-09-14T06:00:00Z'), Date.parse('2026-09-14T18:30:00Z'),
    ])
  })
  it('uses the same map geometry and provider progress as the app', () => {
    const record = flight()
    const route = createFlightRoutePresentation(record.snapshot, now)
    const map = selectWidgetFlights([record], now)[0].card.flightMap!
    for (const key of ['start', 'end', 'control', 'marker'] as const) {
      expect(map[key].x).toBeCloseTo(route[key].x, 3)
      expect(map[key].y).toBeCloseTo(route[key].y, 3)
    }
    expect(map.progress).toBe(40)
    expect(map.advanceWithTime).toBe(false)
    expect(selectWidgetFlights([flight({ progressPercent: null })], now)[0].card.flightMap?.advanceWithTime).toBe(true)
  })
  it('keeps unknown-time flights visible without inventing a position', () => {
    const [{ card }] = selectWidgetFlights([flight({ actualDeparture: null, scheduledDeparture: null, scheduledArrival: null, estimatedArrival: null, progressPercent: null })], now)
    expect(card.subtitle).toContain('time unavailable')
    expect(card.flight).toBeUndefined()
    expect(card.flightMap).toMatchObject({ mode: 'unavailable', progress: null, advanceWithTime: false })
  })
})

describe('flight cards in the shared widget deck', () => {
  const input = { now, theme: 'forest' as const, privacy: 'full' as const, events: [], authorizedCapsules: [], trackedFlights: [flight()] }
  it('selects active flights and adds browseable pages', () => {
    const selection = selectBubbleWidgetTimeline(input)
    expect(selection.snapshot.kind).toBe('flight')
    expect(selection.snapshot.pages).toEqual([expect.objectContaining({ group: 'flights', title: 'JFK → DXB', flight: expect.any(Object) })])
    expect(selection.snapshot.nextRefreshAt).not.toBe('2026-09-14T12:01:00.000Z')
    expect(selection.snapshot.retainedFlight).toBe(true)
    expect(selection.snapshot.expiresAt).toBeUndefined()
  })
  it('keeps traveler, route codes, timetable and expiry out of hidden previews', () => {
    const selection = selectBubbleWidgetTimeline({ ...input, privacy: 'hidden' })
    expect(selection.snapshot.title).toBe('A journey is coming up')
    expect(selection.snapshot.flight).toBeUndefined()
    expect(selection.snapshot.expiresAt).toBeUndefined()
    expect(selection.snapshot.pages).toBeUndefined()
    expect(selection.snapshot.retainedFlight).toBeUndefined()
    expect(selection.snapshot.flightMap).toBeUndefined()
    expect(JSON.stringify(selection)).not.toMatch(/JFK|DXB|Mum|EK202|departureAt|arrivalAt/)
  })
  it('only requests minute updates for time-advancing journeys still underway', () => {
    const estimate = selectBubbleWidgetTimeline({ ...input, trackedFlights: [flight({ progressPercent: null })] })
    expect(estimate.snapshot.nextRefreshAt).toBe('2026-09-14T12:01:00.000Z')
    const completed = selectBubbleWidgetTimeline({ ...input, trackedFlights: [flight({ status: 'Arrived', progressPercent: null })] })
    expect(completed.snapshot.nextRefreshAt).not.toBe('2026-09-14T12:01:00.000Z')
  })
  it('keeps urgent tasks first while retaining flights in the deck', () => {
    const selection = selectBubbleWidgetTimeline({ ...input, events: [{ id: 'task', title: 'Pick up medicine', startsAt: '2026-09-14T12:30:00Z', tasks: [] }] })
    expect(selection.snapshot.kind).toBe('urgent')
    expect(selection.snapshot.pages?.map(({ group }) => group)).toEqual(['flights', 'tasks'])
  })
  it('bounds flight pages while leaving room for other content', () => {
    const selection = selectBubbleWidgetTimeline({ ...input, trackedFlights: Array.from({ length: 20 }, (_, index) => flight({}, String(index))) })
    expect(selection.snapshot.pages).toHaveLength(20)
    expect(new Set(selection.snapshot.pages?.map(({ id }) => id)).size).toBe(20)
  })
  it('fits the entire server flight collection plus other content into native limits', () => {
    const selection = selectBubbleWidgetTimeline({ ...input, trackedFlights: Array.from({ length: 100 }, (_, index) => flight({}, String(index))) })
    expect(selection.snapshot.pages).toHaveLength(100)
    expect(new TextEncoder().encode(JSON.stringify(selection.snapshot)).byteLength).toBeLessThan(256 * 1024)
  })
})
