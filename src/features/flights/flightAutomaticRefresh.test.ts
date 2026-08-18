import { afterEach, describe, expect, it } from 'vitest'
import {
  automaticRefreshWindowMs,
  takeAutomaticRefreshCandidates,
} from './flightAutomaticRefresh'
import type { TrackedFlight } from './types'

const now = new Date('2026-09-10T09:00:00.000Z')

function flight(id: string, departure: string, updatedAt: string): TrackedFlight {
  return {
    id,
    travelerName: id,
    flightNumber: 'EK202',
    travelDate: departure.slice(0, 10),
    createdAt: '2026-08-29T12:00:00.000Z',
    notificationEnabled: false,
    synced: true,
    snapshot: {
      provider: 'aerodatabox',
      providerFlightId: id,
      flightNumber: 'EK202',
      status: 'Scheduled',
      dataQuality: 'scheduled',
      origin: { code: 'JFK', name: null, city: null, latitude: 40.6, longitude: -73.7, timeZone: 'America/New_York' },
      destination: { code: 'DXB', name: null, city: null, latitude: 25.2, longitude: 55.3, timeZone: 'Asia/Dubai' },
      scheduledDeparture: departure,
      estimatedDeparture: null,
      actualDeparture: null,
      scheduledArrival: '2026-09-10T20:00:00.000Z',
      estimatedArrival: null,
      actualArrival: null,
      progressPercent: 0,
      position: null,
      updatedAt,
    },
  }
}

afterEach(() => localStorage.clear())

describe('automatic flight refresh policy', () => {
  it('persists a maximum of two provider calls in each six-hour window', () => {
    const flights = Array.from({ length: 6 }, (_, index) =>
      flight(`flight-${index}`, '2026-09-10T10:00:00.000Z', '2026-09-10T06:00:00.000Z'),
    )
    expect(takeAutomaticRefreshCandidates(flights, 'user:family', now)).toHaveLength(2)
    expect(takeAutomaticRefreshCandidates(
      flights,
      'user:family',
      new Date(now.getTime() + 5 * 60 * 60 * 1000),
    )).toHaveLength(0)
    expect(takeAutomaticRefreshCandidates(
      flights,
      'user:family',
      new Date(now.getTime() + automaticRefreshWindowMs + 1),
    )).toHaveLength(2)
  })

  it('checks nearby flights no more than hourly and far flights daily', () => {
    const near = flight('near', '2026-09-10T10:00:00.000Z', '2026-09-10T07:30:00.000Z')
    const far = flight('far', '2026-09-20T10:00:00.000Z', '2026-09-09T12:00:00.000Z')
    expect(takeAutomaticRefreshCandidates([near, far], 'new-subject', now))
      .toEqual([near])
  })

  it('never refreshes cancelled flights', () => {
    const cancelled = flight('cancelled', '2026-09-10T10:00:00.000Z', '2026-09-10T06:00:00.000Z')
    cancelled.snapshot.status = 'Cancelled'
    expect(takeAutomaticRefreshCandidates([cancelled], 'cancelled-subject', now))
      .toEqual([])
  })

  it('continues polling an uncertain cancellation', () => {
    const uncertain = flight('uncertain', '2026-09-10T10:00:00.000Z', '2026-09-10T06:00:00.000Z')
    uncertain.snapshot.status = 'CanceledUncertain'
    expect(takeAutomaticRefreshCandidates(
      [uncertain],
      'uncertain-subject',
      now,
    )).toEqual([uncertain])
  })
})
