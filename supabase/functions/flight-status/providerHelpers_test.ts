import {
  isAllowedFlightTrackerOrigin,
  isFreshProviderPosition,
  normalizeAirlineFlightNumber,
  parseLastPositionResponse,
  validClientCalendarDate,
  validTravelDateForCalendar,
} from './providerHelpers.ts'

/** Keeps Edge tests dependency-free so a fresh Deno install can run them offline. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test('flight-status accepts only normalized public flight numbers', () => {
  assert(normalizeAirlineFlightNumber(' ek-202 ') === 'EK202', 'normalization failed')
  assert(normalizeAirlineFlightNumber('1234567890123') === null, 'ticket number accepted')
  assert(normalizeAirlineFlightNumber('not a flight') === null, 'invalid text accepted')
})

Deno.test('flight-status allows native origins and explicit web origins only', () => {
  assert(isAllowedFlightTrackerOrigin('https://localhost'), 'Android origin rejected')
  assert(isAllowedFlightTrackerOrigin('capacitor://localhost'), 'iOS origin rejected')
  assert(
    isAllowedFlightTrackerOrigin(
      'https://bubble.example',
      'https://other.example, https://bubble.example',
    ),
    'configured web origin rejected',
  )
  assert(
    !isAllowedFlightTrackerOrigin('https://untrusted.example'),
    'untrusted web origin accepted',
  )
})

Deno.test('flight-status validates client and travel calendar boundaries', () => {
  const serverNow = new Date('2026-01-01T23:30:00Z')
  assert(
    validClientCalendarDate('2025-12-31', serverNow) === '2025-12-31',
    'valid device-local day rejected',
  )
  assert(
    validClientCalendarDate('2025-12-30', serverNow) === null,
    'out-of-range device-local day accepted',
  )
  assert(
    validTravelDateForCalendar('2026-12-31', '2025-12-31') === '2026-12-31',
    'valid travel boundary rejected',
  )
  assert(
    validTravelDateForCalendar('2027-01-01', '2025-12-31') === null,
    'out-of-range travel day accepted',
  )
})

Deno.test('flight-status rejects invalid positions and stale telemetry', () => {
  const invalidPosition = parseLastPositionResponse({
    last_position: {
      latitude: 125,
      longitude: 55,
      timestamp: '2026-09-10T09:55:00Z',
    },
  })
  assert(invalidPosition === null, 'invalid coordinates accepted')

  const validPosition = parseLastPositionResponse({
    last_position: {
      latitude: 25,
      longitude: 55,
      altitude: 351,
      heading: 725,
      timestamp: '2026-09-10T09:50:00Z',
    },
  })
  assert(validPosition !== null, 'valid position was rejected')
  assert(validPosition.altitudeFeet === 35_100, 'altitude was not normalized')
  assert(validPosition.headingDegrees === 5, 'heading was not normalized')
  assert(
    isFreshProviderPosition(
      validPosition,
      new Date('2026-09-10T10:00:00Z').getTime(),
    ),
    'fresh position marked stale',
  )
  assert(
    !isFreshProviderPosition(
      validPosition,
      new Date('2026-09-10T10:10:01Z').getTime(),
    ),
    'stale position marked fresh',
  )
})
