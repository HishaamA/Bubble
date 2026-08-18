import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightStatusSnapshot } from './types'

const supabaseMocks = vi.hoisted(() => ({
  identity: null as Record<string, unknown> | null,
  client: null as {
    from: ReturnType<typeof vi.fn>
    rpc?: ReturnType<typeof vi.fn>
  } | null,
  bootstrapCurrentClerkProfile: vi.fn(),
  accessToken: vi.fn(),
  environment: {
    supabase: null as { url: string; publishableKey: string } | null,
  },
}))

vi.mock('../../lib/env', () => ({
  appEnvironment: supabaseMocks.environment,
}))
vi.mock('../../lib/supabase', () => ({
  getClerkSupabaseAccessToken: supabaseMocks.accessToken,
  getClerkSupabaseIdentity: vi.fn(() => supabaseMocks.identity),
  getSupabaseClient: vi.fn(() => supabaseMocks.client),
}))
vi.mock('../../services/persistence', () => ({
  bootstrapCurrentClerkProfile: supabaseMocks.bootstrapCurrentClerkProfile,
}))

import {
  createTrackedFamilyFlight,
  fetchFamilyFlights,
  flightStatusRequestTimeoutMs,
  refreshTrackedFamilyFlight,
  removeFamilyFlight,
} from './flightStatusService'

const snapshot: FlightStatusSnapshot = {
  provider: 'aerodatabox',
  providerFlightId: '2026-09-10:EK202',
  flightNumber: 'EK202',
  status: 'Scheduled',
  dataQuality: 'scheduled',
  origin: {
    code: 'JFK',
    name: null,
    city: 'New York',
    latitude: 40.6,
    longitude: -73.7,
    timeZone: 'America/New_York',
  },
  destination: {
    code: 'DXB',
    name: null,
    city: 'Dubai',
    latitude: 25.2,
    longitude: 55.3,
    timeZone: 'Asia/Dubai',
  },
  scheduledDeparture: '2026-09-10T10:00:00.000Z',
  estimatedDeparture: null,
  actualDeparture: null,
  scheduledArrival: '2026-09-10T20:00:00.000Z',
  estimatedArrival: null,
  actualArrival: null,
  progressPercent: 0,
  position: null,
  updatedAt: '2026-08-29T12:00:00.000Z',
}

beforeEach(() => {
  vi.stubEnv('VITE_FLIGHT_TRACKER_ENDPOINT', 'https://tracker.example/status')
  supabaseMocks.identity = null
  supabaseMocks.client = null
  supabaseMocks.environment.supabase = null
  supabaseMocks.bootstrapCurrentClerkProfile.mockReset()
  supabaseMocks.accessToken.mockReset().mockResolvedValue('clerk-token')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('trusted flight status requests', () => {
  it('sends create identity but never a client status snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(snapshot),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await createTrackedFamilyFlight({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      travelerName: 'Sara',
      flightNumber: 'ek 202',
      travelDate: '2026-09-10',
      clientCalendarDate: '2026-08-29',
    })

    const request = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(request).toEqual({
      operation: 'create',
      flightId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: '2026-09-10',
      clientCalendarDate: '2026-08-29',
    })
    expect(request).not.toHaveProperty('snapshot')
    expect(request).not.toHaveProperty('status_snapshot')
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer clerk-token',
    })
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('apikey')
  })

  it('derives the Supabase function endpoint and separates API and user credentials', async () => {
    vi.stubEnv('VITE_FLIGHT_TRACKER_ENDPOINT', '')
    supabaseMocks.environment.supabase = {
      url: 'https://project-ref.supabase.co',
      publishableKey: 'sb_publishable_project',
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(snapshot),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await refreshTrackedFamilyFlight(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'EK202',
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://project-ref.supabase.co/functions/v1/flight-status',
      expect.objectContaining({
        headers: expect.objectContaining({
          apikey: 'sb_publishable_project',
          Authorization: 'Bearer clerk-token',
        }),
      }),
    )
  })

  it('fails before the network when no signed-in Clerk token is available', async () => {
    supabaseMocks.accessToken.mockResolvedValue(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(refreshTrackedFamilyFlight(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'EK202',
    )).rejects.toMatchObject({ code: 'auth-required' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('distinguishes missing endpoint configuration from authentication', async () => {
    vi.stubEnv('VITE_FLIGHT_TRACKER_ENDPOINT', '')

    await expect(refreshTrackedFamilyFlight(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'EK202',
    )).rejects.toMatchObject({ code: 'not-configured' })
    expect(supabaseMocks.accessToken).not.toHaveBeenCalled()
  })

  it('maps rejected membership and missing provider configuration accurately', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'An approved family connection is required.' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Live flight tracking is not configured.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      )))

    await expect(refreshTrackedFamilyFlight(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'EK202',
    )).rejects.toMatchObject({ code: 'auth-required' })
    await expect(refreshTrackedFamilyFlight(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'EK202',
    )).rejects.toMatchObject({ code: 'not-configured' })
  })

  it('preserves the provider quota message on a 429 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'AeroDataBox monthly quota is exhausted.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    )))
    await expect(refreshTrackedFamilyFlight(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'EK202',
    )).rejects.toMatchObject({
      code: 'rate-limited',
      message: 'AeroDataBox monthly quota is exhausted.',
    })
  })

  it('times out a Clerk token or fetch that never settles', async () => {
    vi.useFakeTimers()
    supabaseMocks.accessToken.mockReturnValue(new Promise(() => undefined))
    const tokenRequest = refreshTrackedFamilyFlight(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'EK202',
    )
    const tokenExpectation = expect(tokenRequest).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/too long/i),
    })
    await vi.advanceTimersByTimeAsync(flightStatusRequestTimeoutMs)
    await tokenExpectation

    supabaseMocks.accessToken.mockResolvedValue('clerk-token')
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)))
    const fetchRequest = refreshTrackedFamilyFlight(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'EK202',
    )
    const fetchExpectation = expect(fetchRequest).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/too long/i),
    })
    await vi.advanceTimersByTimeAsync(flightStatusRequestTimeoutMs)
    await fetchExpectation
  })

  it('rejects a mismatched response identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ...snapshot, flightNumber: 'EK203' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))

    await expect(createTrackedFamilyFlight({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: '2026-09-10',
      clientCalendarDate: '2026-08-29',
    })).rejects.toThrow(/different flight identity/i)
  })

  it('refreshes by immutable server row ID without resending identity or JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(snapshot),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await refreshTrackedFamilyFlight(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'EK202',
    )
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      operation: 'refresh',
      flightId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })
  })

  it('rejects a refresh response that conflicts with the local immutable identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ...snapshot, flightNumber: 'EK203' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))

    await expect(refreshTrackedFamilyFlight(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'EK202',
    )).rejects.toThrow(/different flight identity/i)
  })

  it('prunes fetched rows from yesterday in the device calendar', async () => {
    const circleQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { circle_id: 'family_test' },
        error: null,
      }),
    }
    const flightQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    supabaseMocks.identity = { userId: 'clerk_user' }
    supabaseMocks.bootstrapCurrentClerkProfile.mockResolvedValue({ userId: 'profile_user' })
    supabaseMocks.client = {
      from: vi.fn((table: string) => table === 'circle_members'
        ? circleQuery
        : flightQuery),
    }
    const now = new Date('2026-01-02T00:30:00Z')
    vi.spyOn(now, 'getFullYear').mockReturnValue(2026)
    vi.spyOn(now, 'getMonth').mockReturnValue(0)
    vi.spyOn(now, 'getDate').mockReturnValue(1)

    await fetchFamilyFlights(now)

    expect(flightQuery.gte).toHaveBeenCalledWith('travel_date', '2025-12-31')
  })

  it('bounds and aborts a family-flight delete request', async () => {
    vi.useFakeTimers()
    const circleQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { circle_id: 'family_test' },
        error: null,
      }),
    }
    const abortSignal = vi.fn().mockReturnValue(new Promise(() => undefined))
    supabaseMocks.identity = { userId: 'clerk_user' }
    supabaseMocks.bootstrapCurrentClerkProfile.mockResolvedValue({ userId: 'profile_user' })
    supabaseMocks.client = {
      from: vi.fn(() => circleQuery),
      rpc: vi.fn(() => ({ abortSignal })),
    }
    const request = removeFamilyFlight('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    const expectation = expect(request).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/too long/i),
    })
    await vi.advanceTimersByTimeAsync(flightStatusRequestTimeoutMs)
    await expectation
    expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
  })
})
