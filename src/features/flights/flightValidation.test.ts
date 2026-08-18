import { describe, expect, it, vi } from 'vitest'
import {
  calculateFlightProgress,
  effectiveFlightDataQuality,
  formatFlightDateTime,
  isFlightCancelled,
  isFlightComplete,
  normalizeFlightNumber,
  shiftLocalCalendarDate,
  ticketNumberMessage,
  validateFlightForm,
} from './flightValidation'
import type { FlightStatusSnapshot } from './types'

const snapshot: FlightStatusSnapshot = {
  provider: 'flightaware',
  providerFlightId: 'UAE202-1',
  flightNumber: 'EK202',
  status: 'En route',
  dataQuality: 'live',
  origin: {
    code: 'JFK',
    name: 'John F. Kennedy International',
    city: 'New York',
    latitude: 40.6413,
    longitude: -73.7781,
    timeZone: 'America/New_York',
  },
  destination: {
    code: 'DXB',
    name: 'Dubai International',
    city: 'Dubai',
    latitude: 25.2532,
    longitude: 55.3657,
    timeZone: 'Asia/Dubai',
  },
  scheduledDeparture: '2026-09-10T10:00:00.000Z',
  estimatedDeparture: null,
  actualDeparture: '2026-09-10T10:00:00.000Z',
  scheduledArrival: '2026-09-10T20:00:00.000Z',
  estimatedArrival: '2026-09-10T20:00:00.000Z',
  actualArrival: null,
  progressPercent: null,
  position: null,
  updatedAt: '2026-09-10T15:00:00.000Z',
}

describe('flight form validation', () => {
  it('normalizes airline flight numbers', () => {
    expect(normalizeFlightNumber(' ek-202 ')).toBe('EK202')
    expect(validateFlightForm({
      travelerName: '  Sara   Ahmed ',
      flightNumber: ' ek 202 ',
      travelDate: '2026-09-10',
    }, new Date('2026-08-29T12:00:00Z'))).toEqual({
      valid: true,
      value: {
        travelerName: 'Sara Ahmed',
        flightNumber: 'EK202',
        travelDate: '2026-09-10',
      },
    })
  })

  it('rejects a 13-digit ticket number with a privacy-specific explanation', () => {
    const result = validateFlightForm({
      travelerName: 'Sara',
      flightNumber: '176-1234567890',
      travelDate: '2026-09-10',
    }, new Date('2026-08-29T12:00:00Z'))

    expect(result).toEqual({
      valid: false,
      field: 'flightNumber',
      message: ticketNumberMessage,
    })
    expect(ticketNumberMessage).toMatch(/never stored/i)
  })

  it('rejects malformed and out-of-range dates', () => {
    expect(validateFlightForm({
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: '2026-02-30',
    }, new Date('2026-08-29T12:00:00Z'))).toMatchObject({
      valid: false,
      field: 'travelDate',
    })
    expect(validateFlightForm({
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: '2028-09-10',
    }, new Date('2026-08-29T12:00:00Z'))).toMatchObject({
      valid: false,
      field: 'travelDate',
    })
  })

  it('accepts AeroDataBox\'s 365-day boundary and rejects the following day', () => {
    const now = new Date('2026-08-29T12:00:00Z')
    expect(validateFlightForm({
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: shiftLocalCalendarDate(now, 365),
    }, now)).toMatchObject({ valid: true })
    expect(validateFlightForm({
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: shiftLocalCalendarDate(now, 366),
    }, now)).toMatchObject({ valid: false, field: 'travelDate' })
  })

  it('uses the device calendar day at a UTC date boundary', () => {
    const now = new Date('2026-01-02T00:30:00Z')
    vi.spyOn(now, 'getFullYear').mockReturnValue(2026)
    vi.spyOn(now, 'getMonth').mockReturnValue(0)
    vi.spyOn(now, 'getDate').mockReturnValue(1)

    expect(shiftLocalCalendarDate(now, -1)).toBe('2025-12-31')
    expect(validateFlightForm({
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: '2025-12-31',
    }, now)).toMatchObject({ valid: true })
  })
})

describe('calculateFlightProgress', () => {
  it('uses provider progress when present and clamps it', () => {
    expect(calculateFlightProgress({ ...snapshot, progressPercent: 63.6 })).toBe(64)
    expect(calculateFlightProgress({ ...snapshot, progressPercent: 130 })).toBe(100)
  })

  it('falls back to departure and ETA timing', () => {
    expect(calculateFlightProgress(
      snapshot,
      new Date('2026-09-10T15:00:00.000Z'),
    )).toBe(50)
  })

  it('reports completed flights at 100 percent', () => {
    expect(calculateFlightProgress({
      ...snapshot,
      actualArrival: '2026-09-10T19:54:00.000Z',
      progressPercent: 2,
    })).toBe(100)
  })

  it('does not treat uncertain cancellation as cancelled or complete', () => {
    for (const status of ['Possibly cancelled', 'CanceledUncertain']) {
      const uncertain = { ...snapshot, status }
      expect(isFlightCancelled(uncertain)).toBe(false)
      expect(isFlightComplete(uncertain)).toBe(false)
      expect(calculateFlightProgress(
        uncertain,
        new Date('2026-09-10T15:00:00.000Z'),
      )).toBe(50)
    }
    expect(isFlightCancelled({ ...snapshot, status: 'Cancelled' })).toBe(true)
    expect(isFlightComplete({ ...snapshot, status: 'Canceled' })).toBe(true)
  })
})

describe('flight freshness and local time zones', () => {
  it('downgrades a stale provider Live marker without changing the stored snapshot', () => {
    const live = {
      ...snapshot,
      dataQuality: 'live' as const,
      position: {
        latitude: 45,
        longitude: 1,
        altitudeFeet: 35_000,
        headingDegrees: 80,
        recordedAt: '2026-09-10T14:50:00.000Z',
      },
    }
    expect(effectiveFlightDataQuality(live, new Date('2026-09-10T15:00:00Z'))).toBe('live')
    expect(effectiveFlightDataQuality(live, new Date('2026-09-10T15:06:00Z'))).toBe('estimated')
    expect(live.dataQuality).toBe('live')
  })

  it('formats departure and arrival in their airport IANA time zones', () => {
    const departure = formatFlightDateTime(
      '2026-09-10T12:00:00.000Z',
      'America/New_York',
    )
    const arrival = formatFlightDateTime(
      '2026-09-10T12:00:00.000Z',
      'Asia/Dubai',
    )
    expect(departure).toMatchObject({ date: 'Thu, Sep 10', timeZone: 'America/New_York' })
    expect(departure?.time).toMatch(/8:00/)
    expect(arrival).toMatchObject({ date: 'Thu, Sep 10', timeZone: 'Asia/Dubai' })
    expect(arrival?.time).toMatch(/4:00/)
  })
})
