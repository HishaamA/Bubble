import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  aerodataboxLookup,
  aerodataboxStatus,
  clearAeroDataBoxProviderCachesForTest,
} from '../../../supabase/functions/flight-status/aerodataboxProvider.ts'

const apiKey = 'test-rapidapi-key'

function airport(
  iata: string,
  icao: string,
  name: string,
  city: string,
  latitude: number,
  longitude: number,
  timeZone: string,
) {
  return {
    iata,
    icao,
    name,
    municipalityName: city,
    location: { lat: latitude, lon: longitude },
    timeZone,
  }
}

const dubai = airport(
  'DXB',
  'OMDB',
  'Dubai International Airport',
  'Dubai',
  25.2528,
  55.3644,
  'Asia/Dubai',
)
const heathrow = airport(
  'LHR',
  'EGLL',
  'London Heathrow Airport',
  'London',
  51.47,
  -0.4543,
  'Europe/London',
)

function movement(
  airportValue: Record<string, unknown>,
  utc: string,
  local: string,
  extra: Record<string, unknown> = {},
) {
  return {
    airport: airportValue,
    scheduledTime: { utc, local },
    quality: ['Basic'],
    ...extra,
  }
}

function flightContract({
  number = 'EK 202',
  date = '2026-09-10',
  status = 'Expected',
  codeshareStatus = 'Unknown',
  airline = { iata: 'EK', icao: 'UAE' },
  origin = dubai,
  destination = heathrow,
  departureExtra = {},
  arrivalExtra = {},
  location,
}: {
  number?: string
  date?: string
  status?: string
  codeshareStatus?: string
  airline?: Record<string, unknown>
  origin?: Record<string, unknown>
  destination?: Record<string, unknown>
  departureExtra?: Record<string, unknown>
  arrivalExtra?: Record<string, unknown>
  location?: unknown
} = {}) {
  return {
    number,
    status,
    codeshareStatus,
    airline,
    departure: movement(
      origin,
      `${date}T06:00:00Z`,
      `${date}T10:00:00+04:00`,
      departureExtra,
    ),
    arrival: movement(
      destination,
      `${date}T13:00:00Z`,
      `${date}T14:00:00+01:00`,
      arrivalExtra,
    ),
    ...(location === undefined ? {} : { location }),
    lastUpdatedUtc: `${date}T09:55:00Z`,
  }
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers?: HeadersInit,
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('AeroDataBox provider adapter', () => {
  beforeEach(() => {
    clearAeroDataBoxProviderCachesForTest()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T10:00:00Z'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('uses the exact RapidAPI request and normalizes a current live flight', async () => {
    const row = flightContract({
      status: 'EnRoute',
      departureExtra: {
        revisedTime: {
          utc: '2026-09-10T06:05:00Z',
          local: '2026-09-10T10:05:00+04:00',
        },
        runwayTime: {
          utc: '2026-09-10T06:12:00Z',
          local: '2026-09-10T10:12:00+04:00',
        },
        quality: ['Basic', 'Live'],
      },
      arrivalExtra: {
        revisedTime: {
          utc: '2026-09-10T13:20:00Z',
          local: '2026-09-10T14:20:00+01:00',
        },
        predictedTime: {
          utc: '2026-09-10T13:25:00Z',
          local: '2026-09-10T14:25:00+01:00',
        },
        quality: ['Basic', 'Live'],
      },
      location: {
        lat: 31.2,
        lon: 41.4,
        altitude: { feet: 35_750 },
        trueTrack: { deg: 725 },
        reportedAtUtc: '2026-09-10T09:58:00Z',
      },
    })
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse([row])),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await aerodataboxStatus(' ek-202 ', '2026-09-10', apiKey)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://aerodatabox.p.rapidapi.com/flights/number/EK202/2026-09-10'
        + '?dateLocalRole=Departure&withLocation=true&withAircraftImage=false',
    )
    const headers = new Headers(options.headers)
    expect(headers.get('X-RapidAPI-Key')).toBe(apiKey)
    expect(headers.get('X-RapidAPI-Host')).toBe('aerodatabox.p.rapidapi.com')
    expect(result).toMatchObject({
      provider: 'aerodatabox',
      providerFlightId: 'EK202:2026-09-10T06:00:00.000Z',
      flightNumber: 'EK202',
      operatingFlightNumber: null,
      status: 'En route',
      dataQuality: 'live',
      origin: {
        code: 'DXB',
        city: 'Dubai',
        latitude: 25.2528,
        longitude: 55.3644,
        timeZone: 'Asia/Dubai',
      },
      destination: {
        code: 'LHR',
        city: 'London',
        latitude: 51.47,
        longitude: -0.4543,
        timeZone: 'Europe/London',
      },
      scheduledDeparture: '2026-09-10T06:00:00.000Z',
      estimatedDeparture: null,
      actualDeparture: '2026-09-10T06:12:00.000Z',
      scheduledArrival: '2026-09-10T13:00:00.000Z',
      estimatedArrival: '2026-09-10T13:20:00.000Z',
      actualArrival: null,
      position: {
        latitude: 31.2,
        longitude: 41.4,
        altitudeFeet: 35_750,
        headingDegrees: 5,
        recordedAt: '2026-09-10T09:58:00.000Z',
      },
      updatedAt: '2026-09-10T09:58:00.000Z',
    })
  })

  it('keeps a future flight scheduled and rejects an invalid position', async () => {
    const row = flightContract({
      number: 'EK 203',
      status: 'Expected',
      location: {
        lat: 125,
        lon: 41.4,
        altitude: { feet: 0 },
        trueTrack: { deg: 90 },
        reportedAtUtc: '2026-09-10T09:58:00Z',
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([row])))

    const result = await aerodataboxStatus('EK203', '2026-09-10', apiKey)

    expect(result).toMatchObject({
      status: 'Expected',
      dataQuality: 'scheduled',
      estimatedDeparture: null,
      estimatedArrival: null,
      actualDeparture: null,
      actualArrival: null,
      position: null,
    })
  })

  it('maps completed movement times to actual and uses predicted as estimate fallback', async () => {
    const arrived = flightContract({
      number: 'EK 204',
      status: 'Arrived',
      departureExtra: {
        revisedTime: { utc: '2026-09-10T06:08:00Z' },
        runwayTime: { utc: '2026-09-10T06:11:00Z' },
      },
      arrivalExtra: {
        revisedTime: { utc: '2026-09-10T13:06:00Z' },
        runwayTime: { utc: '2026-09-10T13:09:00Z' },
        predictedTime: { utc: '2026-09-10T13:04:00Z' },
      },
    })
    const predicted = flightContract({
      number: 'EK 205',
      status: 'GateClosed',
      departureExtra: {
        predictedTime: { utc: '2026-09-10T06:17:00Z' },
      },
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([arrived]))
      .mockResolvedValueOnce(jsonResponse([predicted]))
    vi.stubGlobal('fetch', fetchMock)

    const completed = await aerodataboxStatus('EK204', '2026-09-10', apiKey)
    const waitingLookup = aerodataboxStatus('EK205', '2026-09-10', apiKey)
    await vi.advanceTimersByTimeAsync(1_000)
    const waiting = await waitingLookup

    expect(completed).toMatchObject({
      status: 'Arrived',
      actualDeparture: '2026-09-10T06:11:00.000Z',
      estimatedDeparture: null,
      actualArrival: '2026-09-10T13:09:00.000Z',
      estimatedArrival: null,
      dataQuality: 'estimated',
    })
    expect(waiting).toMatchObject({
      status: 'Gate closed',
      actualDeparture: null,
      estimatedDeparture: '2026-09-10T06:17:00.000Z',
      dataQuality: 'estimated',
    })
  })

  it('requires an operational state before live movement quality becomes live', async () => {
    const expected = flightContract({
      number: 'EK 206',
      status: 'Expected',
      departureExtra: { quality: ['Basic', 'Live'] },
    })
    const boarding = flightContract({
      number: 'EK 207',
      status: 'Boarding',
      departureExtra: { quality: ['Basic', 'Live'] },
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([expected]))
      .mockResolvedValueOnce(jsonResponse([boarding]))
    vi.stubGlobal('fetch', fetchMock)

    await expect(aerodataboxStatus('EK206', '2026-09-10', apiKey))
      .resolves.toMatchObject({ dataQuality: 'estimated' })
    const boardingLookup = aerodataboxStatus('EK207', '2026-09-10', apiKey)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(boardingLookup)
      .resolves.toMatchObject({ dataQuality: 'live' })
  })

  it('ignores provider rows with the wrong normalized identity or departure date', async () => {
    const wrongNumber = flightContract({ number: 'EK 999' })
    const wrongDate = flightContract({ number: 'EK 208', date: '2026-09-11' })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([
      wrongNumber,
      wrongDate,
    ]))
    vi.stubGlobal('fetch', fetchMock)

    await expect(aerodataboxStatus('EK208', '2026-09-10', apiKey))
      .resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('matches leading-zero and IATA/ICAO aliases without changing the requested identity', async () => {
    const leadingZero = flightContract({
      number: 'EK 11',
      codeshareStatus: 'IsOperator',
    })
    const icaoAlias = flightContract({
      number: 'DL 1919',
      codeshareStatus: 'IsOperator',
      airline: { iata: 'DL', icao: 'DAL' },
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([leadingZero]))
      .mockResolvedValueOnce(jsonResponse([icaoAlias]))
    vi.stubGlobal('fetch', fetchMock)

    const ekLookup = await aerodataboxStatus('EK011', '2026-09-10', apiKey)
    const deltaLookup = aerodataboxStatus('DAL1919', '2026-09-10', apiKey)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(deltaLookup).resolves.toMatchObject({
      flightNumber: 'DAL1919',
      operatingFlightNumber: null,
      providerFlightId: 'DL1919:2026-09-10T06:00:00.000Z',
    })
    expect(ekLookup).toMatchObject({
      flightNumber: 'EK011',
      operatingFlightNumber: null,
      providerFlightId: 'EK11:2026-09-10T06:00:00.000Z',
    })
  })

  it('matches a codeshare by its origin-local departure date, not arrival date', async () => {
    const operator = flightContract({
      number: 'FZ 1482',
      date: '2026-09-09',
      codeshareStatus: 'IsOperator',
      airline: { iata: 'FZ', icao: 'FDB' },
      origin: heathrow,
      destination: dubai,
      arrivalExtra: {
        scheduledTime: {
          utc: '2026-09-09T22:55:00Z',
          local: '2026-09-10T02:55:00+04:00',
        },
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([operator])))

    await expect(aerodataboxStatus('EK2384', '2026-09-10', apiKey))
      .resolves.toBeNull()

    clearAeroDataBoxProviderCachesForTest()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([operator])))
    await expect(aerodataboxStatus('EK2384', '2026-09-09', apiKey))
      .resolves.toMatchObject({
        flightNumber: 'EK2384',
        operatingFlightNumber: 'FZ1482',
        providerFlightId: 'FZ1482:2026-09-09T06:00:00.000Z',
        origin: { code: 'LHR' },
        destination: { code: 'DXB' },
      })
  })

  it('rejects unrelated codeshared rows and ambiguous operator occurrences', async () => {
    const unrelatedCodeshare = flightContract({
      number: 'FZ 1482',
      codeshareStatus: 'IsCodeshared',
      airline: { iata: 'FZ', icao: 'FDB' },
    })
    const firstOperator = flightContract({
      number: 'FZ 1482',
      codeshareStatus: 'IsOperator',
      airline: { iata: 'FZ', icao: 'FDB' },
    })
    const secondOperator = flightContract({
      number: 'FZ 1482',
      codeshareStatus: 'IsOperator',
      airline: { iata: 'FZ', icao: 'FDB' },
      departureExtra: {
        scheduledTime: {
          utc: '2026-09-10T18:00:00Z',
          local: '2026-09-10T22:00:00+04:00',
        },
      },
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([unrelatedCodeshare]))
      .mockResolvedValueOnce(jsonResponse([firstOperator, secondOperator]))
    vi.stubGlobal('fetch', fetchMock)

    await expect(aerodataboxStatus('EK2384', '2026-09-10', apiKey))
      .resolves.toBeNull()
    const ambiguous = aerodataboxStatus('EK2385', '2026-09-10', apiKey)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(ambiguous).resolves.toBeNull()
  })

  it('returns sanitized choices for multiple departure-local matches and revalidates the selection', async () => {
    const first = flightContract({
      number: 'EK 230',
      departureExtra: {
        scheduledTime: {
          utc: '2026-09-10T06:00:00Z',
          local: '2026-09-10T10:00:00+04:00',
        },
      },
    })
    const second = flightContract({
      number: 'EK 230',
      departureExtra: {
        scheduledTime: {
          utc: '2026-09-10T18:00:00Z',
          local: '2026-09-10T22:00:00+04:00',
        },
      },
    })
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse([second, first])),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await aerodataboxLookup('EK230', '2026-09-10', apiKey)

    expect(result).toEqual({
      kind: 'choices',
      choices: [
        expect.objectContaining({
          providerFlightId: 'EK230:2026-09-10T06:00:00.000Z',
          flightNumber: 'EK230',
          origin: expect.objectContaining({ code: 'DXB' }),
          destination: expect.objectContaining({ code: 'LHR' }),
          scheduledDeparture: '2026-09-10T06:00:00.000Z',
        }),
        expect.objectContaining({
          providerFlightId: 'EK230:2026-09-10T18:00:00.000Z',
          scheduledDeparture: '2026-09-10T18:00:00.000Z',
        }),
      ],
    })

    const selectedLookup = aerodataboxLookup(
      'EK230',
      '2026-09-10',
      apiKey,
      null,
      'EK230:2026-09-10T18:00:00.000Z',
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(selectedLookup).resolves.toMatchObject({
      kind: 'created',
      snapshot: {
        providerFlightId: 'EK230:2026-09-10T18:00:00.000Z',
        flightNumber: 'EK230',
        scheduledDeparture: '2026-09-10T18:00:00.000Z',
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a selected provider identity that is not in the departure-date results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([
      flightContract({ number: 'EK 231' }),
    ])))

    await expect(aerodataboxLookup(
      'EK231',
      '2026-09-10',
      apiKey,
      null,
      'EK231:2026-09-10T18:00:00.000Z',
    )).resolves.toBeNull()
  })

  it('treats a 204 flight response as no match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    ))

    await expect(aerodataboxStatus('EK209', '2026-09-10', apiKey))
      .resolves.toBeNull()
  })

  it('fills missing embedded airport geometry from the exact airport endpoint and caches it', async () => {
    const incompleteDubai = {
      iata: 'DXB',
      icao: 'OMDB',
      name: 'Dubai International Airport',
      municipalityName: 'Dubai',
    }
    const firstFlight = flightContract({
      number: 'EK 210',
      origin: incompleteDubai,
    })
    const secondFlight = flightContract({
      number: 'EK 211',
      origin: incompleteDubai,
    })
    const fallbackDubai = { ...dubai }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([firstFlight]))
      .mockResolvedValueOnce(jsonResponse(fallbackDubai))
      .mockResolvedValueOnce(jsonResponse([secondFlight]))
    vi.stubGlobal('fetch', fetchMock)

    const firstLookup = aerodataboxStatus('EK210', '2026-09-10', apiKey)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    const first = await firstLookup
    const secondLookup = aerodataboxStatus('EK211', '2026-09-10', apiKey)
    await vi.advanceTimersByTimeAsync(1_000)
    const second = await secondLookup

    expect(first?.origin).toMatchObject({
      code: 'DXB',
      latitude: 25.2528,
      longitude: 55.3644,
      timeZone: 'Asia/Dubai',
    })
    expect(second?.origin).toEqual(first?.origin)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://aerodatabox.p.rapidapi.com/airports/Iata/DXB',
    )
  })

  it('reuses an exact previous airport snapshot before making a fallback request', async () => {
    const incompleteDubai = {
      iata: 'DXB',
      icao: 'OMDB',
      name: 'Updated Dubai Airport Name',
    }
    const row = flightContract({ number: 'EK 212', origin: incompleteDubai })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([row]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await aerodataboxStatus(
      'EK212',
      '2026-09-10',
      apiKey,
      {
        origin: {
          code: 'DXB',
          name: 'Old name',
          city: 'Dubai',
          latitude: 25.2528,
          longitude: 55.3644,
          timeZone: 'Asia/Dubai',
        },
      },
    )

    expect(result?.origin).toMatchObject({
      code: 'DXB',
      name: 'Updated Dubai Airport Name',
      latitude: 25.2528,
      longitude: 55.3644,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects fallback airport data that does not match the requested code', async () => {
    const incompleteDubai = { iata: 'DXB', icao: 'OMDB' }
    const row = flightContract({ number: 'EK 213', origin: incompleteDubai })
    const wrongAirport = airport(
      'AUH',
      'OMAA',
      'Zayed International Airport',
      'Abu Dhabi',
      24.433,
      54.651,
      'Asia/Dubai',
    )
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([row]))
      .mockResolvedValueOnce(jsonResponse(wrongAirport))
    vi.stubGlobal('fetch', fetchMock)

    const lookup = aerodataboxStatus('EK213', '2026-09-10', apiKey)
    const rejection = expect(lookup)
      .rejects.toMatchObject({ code: 'incomplete' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await rejection
  })

  it.each([
    [401, { message: 'Invalid API key' }, {}, 'auth'],
    [403, { message: 'You are not subscribed to this API' }, {}, 'plan'],
    [429, { message: 'Monthly quota exceeded' }, {}, 'quota'],
  ] as const)(
    'maps provider HTTP %s responses to a safe %s error',
    async (status, body, headers, expectedCode) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        jsonResponse(body, status, headers),
      ))

      await expect(aerodataboxStatus('EK214', '2026-09-10', apiKey))
        .rejects.toMatchObject({ code: expectedCode })
    },
  )

  it.each([
    [
      {
        message: 'Bad request',
        details: [{ code: 'SubscriptionPlanRestriction', reason: 'Future depth is not available on this plan' }],
      },
      'plan',
    ],
    [
      {
        message: 'Bad request',
        details: [{ code: 'InvalidArgument', reason: 'Flight number has a bad value' }],
      },
      'incomplete',
    ],
  ] as const)(
    'reads ErrorContract details when mapping HTTP 400',
    async (body, expectedCode) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        jsonResponse(body, 400),
      ))

      await expect(aerodataboxStatus('EK217', '2026-09-10', apiKey))
        .rejects.toMatchObject({ code: expectedCode })
    },
  )

  it('paces all provider requests at least one second apart', async () => {
    const requestTimes: number[] = []
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      requestTimes.push(Date.now())
      const number = url.includes('/EK218/') ? 'EK 218' : 'EK 219'
      return Promise.resolve(jsonResponse([flightContract({ number })]))
    })
    vi.stubGlobal('fetch', fetchMock)

    const first = aerodataboxStatus('EK218', '2026-09-10', apiKey)
    const second = aerodataboxStatus('EK219', '2026-09-10', apiKey)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestTimes[1] - requestTimes[0]).toBe(1_000)
  })

  it('retries a rate-limited request once after Retry-After', async () => {
    const row = flightContract({ number: 'EK 220' })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(
        { message: 'Too many requests: rate limit' },
        429,
        { 'Retry-After': '2' },
      ))
      .mockResolvedValueOnce(jsonResponse([row]))
    vi.stubGlobal('fetch', fetchMock)

    const lookup = aerodataboxStatus('EK220', '2026-09-10', apiKey)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(lookup).resolves.toMatchObject({ flightNumber: 'EK220' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('bounds Retry-After and never retries a second 429', async () => {
    const rateResponse = () => jsonResponse(
      { message: 'Too many requests: rate limit' },
      429,
      { 'Retry-After': '999' },
    )
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(rateResponse()),
    )
    vi.stubGlobal('fetch', fetchMock)

    const lookup = aerodataboxStatus('EK221', '2026-09-10', apiKey)
    const rejection = expect(lookup).rejects.toMatchObject({ code: 'rate' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await rejection
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses the newest provider update timestamp and labels uncertain cancellation', async () => {
    const row = flightContract({
      number: 'EK 222',
      status: 'CanceledUncertain',
      location: {
        lat: 31.2,
        lon: 41.4,
        altitude: { feet: 20_000 },
        trueTrack: { deg: 180 },
        reportedAtUtc: '2026-09-10T09:50:00Z',
      },
    })
    row.lastUpdatedUtc = '2026-09-10T09:59:00Z'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([row])))

    const result = await aerodataboxStatus('EK222', '2026-09-10', apiKey)

    expect(result).toMatchObject({
      status: 'Possibly cancelled',
      updatedAt: '2026-09-10T09:59:00.000Z',
      position: { recordedAt: '2026-09-10T09:50:00.000Z' },
    })
  })

  it('caches a result for 60 seconds and refreshes after expiry', async () => {
    const row = flightContract({ number: 'EK 215' })
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse([row])),
    )
    vi.stubGlobal('fetch', fetchMock)

    const first = await aerodataboxStatus('EK215', '2026-09-10', apiKey)
    const cached = await aerodataboxStatus('EK215', '2026-09-10', apiKey)
    vi.advanceTimersByTime(60_001)
    const refreshed = await aerodataboxStatus('EK215', '2026-09-10', apiKey)

    expect(cached).toBe(first)
    expect(refreshed).not.toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent lookups for the same provider-prefixed cache key', async () => {
    const row = flightContract({ number: 'EK 216' })
    let resolveFetch: ((response: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const fetchMock = vi.fn().mockReturnValue(pending)
    vi.stubGlobal('fetch', fetchMock)

    const first = aerodataboxStatus('EK216', '2026-09-10', apiKey)
    const second = aerodataboxStatus('EK216', '2026-09-10', apiKey)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    resolveFetch?.(jsonResponse([row]))

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toBe(secondResult)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
