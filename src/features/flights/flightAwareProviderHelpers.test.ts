import { describe, expect, it } from 'vitest'
import {
  activeFlightLookupRange,
  isFreshProviderPosition,
  isAllowedFlightTrackerOrigin,
  parseLastPositionResponse,
  providerFlightRows,
  validClientCalendarDate,
  validTravelDateForCalendar,
} from '../../../supabase/functions/flight-status/providerHelpers.ts'

describe('FlightAware provider helpers', () => {
  it('uses the active endpoint only when the complete date search fits provider bounds', () => {
    const now = new Date('2026-09-10T12:00:00.000Z')
    expect(activeFlightLookupRange('2026-09-10', now)).toEqual({
      start: '2026-09-09T06:00:00.000Z',
      end: '2026-09-11T17:59:59.999Z',
    })
    expect(activeFlightLookupRange('2026-08-31', now)).toBeNull()
    expect(activeFlightLookupRange('2026-09-12', now)).toBeNull()
  })

  it('allows both native Capacitor origins and only explicitly configured web origins', () => {
    expect(isAllowedFlightTrackerOrigin('https://localhost')).toBe(true)
    expect(isAllowedFlightTrackerOrigin('capacitor://localhost')).toBe(true)
    expect(isAllowedFlightTrackerOrigin(
      'https://kinsphere.example',
      'https://other.example, https://kinsphere.example',
    )).toBe(true)
    expect(isAllowedFlightTrackerOrigin('https://untrusted.example')).toBe(false)
  })

  it('reads schedule rows from the official nested response shape', () => {
    const row = {
      ident: 'UAE202',
      ident_iata: 'EK202',
      scheduled_out: '2026-09-10T10:00:00Z',
    }
    expect(providerFlightRows({ scheduled: [row], links: null })).toEqual([row])
    expect(providerFlightRows({ scheduled: [null, 'bad'] })).toEqual([])
  })

  it('normalizes last_position altitude, heading, and epoch seconds', () => {
    expect(parseLastPositionResponse({
      last_position: {
        latitude: 25.25,
        longitude: 55.36,
        altitude: 351,
        heading: 725,
        timestamp: 1_788_947_400,
      },
    })).toEqual({
      latitude: 25.25,
      longitude: 55.36,
      altitudeFeet: 35_100,
      headingDegrees: 5,
      recordedAt: '2026-09-09T09:50:00.000Z',
    })
  })

  it('rejects invalid coordinates and only treats recent positions as live', () => {
    expect(parseLastPositionResponse({
      last_position: {
        latitude: 125,
        longitude: 55,
        timestamp: '2026-09-10T09:55:00Z',
      },
    })).toBeNull()
    const position = parseLastPositionResponse({
      last_position: {
        latitude: 25,
        longitude: 55,
        altitude: 0,
        heading: 90,
        timestamp: '2026-09-10T09:50:00Z',
      },
    })
    expect(isFreshProviderPosition(
      position,
      new Date('2026-09-10T10:00:00Z').getTime(),
    )).toBe(true)
    expect(isFreshProviderPosition(
      position,
      new Date('2026-09-10T10:10:01Z').getTime(),
    )).toBe(false)
  })

  it('bounds travel dates from the explicit device calendar day', () => {
    const serverNow = new Date('2026-01-01T23:30:00Z')
    expect(validClientCalendarDate('2025-12-31', serverNow)).toBe('2025-12-31')
    expect(validClientCalendarDate('2026-01-02', serverNow)).toBe('2026-01-02')
    expect(validClientCalendarDate('2025-12-30', serverNow)).toBeNull()

    expect(validTravelDateForCalendar('2025-12-30', '2025-12-31')).toBe('2025-12-30')
    expect(validTravelDateForCalendar('2026-12-31', '2025-12-31')).toBe('2026-12-31')
    expect(validTravelDateForCalendar('2027-01-01', '2025-12-31')).toBeNull()
    expect(validTravelDateForCalendar('2025-12-29', '2025-12-31')).toBeNull()
    expect(validTravelDateForCalendar('2026-02-30', '2025-12-31')).toBeNull()
  })
})
