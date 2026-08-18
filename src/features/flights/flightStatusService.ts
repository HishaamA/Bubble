import { appEnvironment } from '../../lib/env'
import {
  getClerkSupabaseAccessToken,
  getClerkSupabaseIdentity,
  getSupabaseClient,
} from '../../lib/supabase'
import { bootstrapCurrentClerkProfile } from '../../services/persistence'
import { isFlightStatusSnapshot, isTrackedFlight } from './flightStorage'
import {
  looksLikeTicketNumber,
  normalizeFlightNumber,
  shiftLocalCalendarDate,
} from './flightValidation'
import type { TrackedFlight } from './types'

type FamilyFlightRow = {
  id?: unknown
  traveler_name?: unknown
  flight_number?: unknown
  travel_date?: unknown
  status_snapshot?: unknown
  created_at?: unknown
}

export class FlightStatusError extends Error {
  readonly code:
    | 'not-configured'
    | 'auth-required'
    | 'not-found'
    | 'invalid'
    | 'rate-limited'
    | 'cancelled'
    | 'unavailable'

  constructor(
    message: string,
    code:
      | 'not-configured'
      | 'auth-required'
      | 'not-found'
      | 'invalid'
      | 'rate-limited'
      | 'cancelled'
      | 'unavailable',
  ) {
    super(message)
    this.name = 'FlightStatusError'
    this.code = code
  }
}

export const flightStatusRequestTimeoutMs = 20_000

export type FlightStatusRequestOptions = {
  signal?: AbortSignal
}

function configuredFlightEndpoint() {
  const explicit = import.meta.env.VITE_FLIGHT_TRACKER_ENDPOINT?.trim()
  if (explicit) return explicit
  if (appEnvironment.supabase) {
    return `${appEnvironment.supabase.url}/functions/v1/flight-status`
  }
  return null
}

async function responseMessage(response: Response) {
  try {
    const body = await response.json() as { error?: unknown }
    return typeof body.error === 'string' ? body.error : null
  } catch {
    return null
  }
}

type CreateTrackedFamilyFlightInput = {
  id: string
  travelerName: string
  flightNumber: string
  travelDate: string
  clientCalendarDate: string
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', handleAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', handleAbort)
        reject(error)
      },
    )
  })
}

async function requestFlightStatus(
  body: Record<string, string>,
  options: FlightStatusRequestOptions = {},
) {
  if (looksLikeTicketNumber(body.flightNumber ?? '')) {
    throw new FlightStatusError(
      'Ticket numbers cannot be resolved by public flight trackers. Enter the flight number and date instead.',
      'invalid',
    )
  }
  const endpoint = configuredFlightEndpoint()
  if (!endpoint) {
    throw new FlightStatusError(
      'Live flight tracking is not connected yet. Configure the secure flight-status endpoint and try again.',
      'not-configured',
    )
  }

  const controller = new AbortController()
  let timedOut = false
  const timeout = window.setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Flight status request timed out', 'TimeoutError'))
  }, flightStatusRequestTimeoutMs)
  const forwardAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  if (options.signal?.aborted) forwardAbort()

  try {
    const token = await waitWithSignal(
      getClerkSupabaseAccessToken(),
      controller.signal,
    )
    if (!token) {
      throw new FlightStatusError(
        'Sign in and connect to a family before using live flight tracking.',
        'auth-required',
      )
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    }
    if (appEnvironment.supabase) {
      headers.apikey = appEnvironment.supabase.publishableKey
    }

    const response = await waitWithSignal(
      fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      controller.signal,
    )

    if (!response.ok) {
      const providerMessage = await waitWithSignal(
        responseMessage(response),
        controller.signal,
      )
      if (response.status === 404) {
        throw new FlightStatusError(
          providerMessage
            ?? 'No matching flight was found. Check the number and travel date.',
          'not-found',
        )
      }
      if (response.status === 400 || response.status === 422) {
        throw new FlightStatusError(
          providerMessage ?? 'Check the flight number and travel date.',
          'invalid',
        )
      }
      if (response.status === 429) {
        throw new FlightStatusError(
          providerMessage
            ?? 'Flight updates are busy right now. Wait a moment and try again.',
          'rate-limited',
        )
      }
      if (response.status === 401 || response.status === 403) {
        throw new FlightStatusError(
          providerMessage
            ?? 'Sign in and connect to a family before using live flight tracking.',
          'auth-required',
        )
      }
      if (response.status === 503 && providerMessage?.toLowerCase().includes('not configured')) {
        throw new FlightStatusError(providerMessage, 'not-configured')
      }
      throw new FlightStatusError(
        providerMessage ?? 'Flight status is temporarily unavailable.',
        'unavailable',
      )
    }

    const responseBody = await waitWithSignal(
      response.json() as Promise<unknown>,
      controller.signal,
    )
    if (!isFlightStatusSnapshot(responseBody)) {
      throw new FlightStatusError(
        'The flight provider returned an incomplete update. Try again shortly.',
        'unavailable',
      )
    }
    return responseBody
  } catch (error) {
    if (error instanceof FlightStatusError) throw error
    if (timedOut) {
      throw new FlightStatusError(
        'Flight status took too long to respond. Check your connection and try again.',
        'unavailable',
      )
    }
    if (options.signal?.aborted) {
      throw new FlightStatusError('Flight update was cancelled.', 'cancelled')
    }
    throw new FlightStatusError(
      'Flight status is unreachable. Check your connection and try again.',
      'unavailable',
    )
  } finally {
    window.clearTimeout(timeout)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}

/**
 * The Edge Function performs the provider lookup and trusted insert together.
 * The client never sends a status snapshot to PostgreSQL.
 */
export async function createTrackedFamilyFlight(
  input: CreateTrackedFamilyFlightInput,
  options: FlightStatusRequestOptions = {},
) {
  const expectedFlightNumber = normalizeFlightNumber(input.flightNumber)
  const snapshot = await requestFlightStatus({
    operation: 'create',
    flightId: input.id,
    travelerName: input.travelerName,
    flightNumber: expectedFlightNumber,
    travelDate: input.travelDate,
    clientCalendarDate: input.clientCalendarDate,
  }, options)
  if (snapshot.flightNumber !== expectedFlightNumber) {
    throw new FlightStatusError(
      'The secure tracker returned a different flight identity.',
      'unavailable',
    )
  }
  return snapshot
}

/** Refresh identity comes from the stored row; the optional value is response-only defense. */
export async function refreshTrackedFamilyFlight(
  flightId: string,
  expectedFlightNumber?: string,
  options: FlightStatusRequestOptions = {},
) {
  const snapshot = await requestFlightStatus(
    { operation: 'refresh', flightId },
    options,
  )
  if (
    expectedFlightNumber
    && snapshot.flightNumber !== normalizeFlightNumber(expectedFlightNumber)
  ) {
    throw new FlightStatusError(
      'The secure tracker returned a different flight identity.',
      'unavailable',
    )
  }
  return snapshot
}

async function familyContext() {
  const client = getSupabaseClient()
  if (!client || !getClerkSupabaseIdentity()) return null
  const { userId } = await bootstrapCurrentClerkProfile()
  const { data, error } = await client
    .from('circle_members')
    .select('circle_id')
    .eq('user_id', userId)
    .eq('status', 'approved')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (typeof data?.circle_id !== 'string') return null
  return { client, circleId: data.circle_id }
}

function rowToTrackedFlight(row: FamilyFlightRow): TrackedFlight | null {
  const candidate = {
    id: row.id,
    travelerName: row.traveler_name,
    flightNumber: row.flight_number,
    travelDate: row.travel_date,
    createdAt: row.created_at,
    snapshot: row.status_snapshot,
    notificationEnabled: false,
    synced: true,
  }
  return isTrackedFlight(candidate) ? candidate : null
}

export async function fetchFamilyFlights(now = new Date()): Promise<TrackedFlight[]> {
  const context = await familyContext()
  if (!context) return []
  const { data, error } = await context.client
    .from('family_flights')
    .select('id,traveler_name,flight_number,travel_date,status_snapshot,created_at')
    .eq('circle_id', context.circleId)
    .gte('travel_date', shiftLocalCalendarDate(now, -1))
    .order('travel_date', { ascending: true })
    .limit(100)
  if (error) throw error
  return ((data ?? []) as FamilyFlightRow[])
    .map(rowToTrackedFlight)
    .filter((flight): flight is TrackedFlight => flight !== null)
}

export async function removeFamilyFlight(
  flightId: string,
  options: FlightStatusRequestOptions = {},
) {
  const controller = new AbortController()
  let timedOut = false
  const timeout = window.setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Flight removal timed out', 'TimeoutError'))
  }, flightStatusRequestTimeoutMs)
  const forwardAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  if (options.signal?.aborted) forwardAbort()

  try {
    const context = await waitWithSignal(familyContext(), controller.signal)
    if (!context) return false
    const request = context.client.rpc('delete_family_flight', {
      p_flight_id: flightId,
    }).abortSignal(controller.signal)
    const { error } = await waitWithSignal(
      Promise.resolve(request),
      controller.signal,
    )
    if (error) throw error
    return true
  } catch (error) {
    if (error instanceof FlightStatusError) throw error
    if (timedOut) {
      throw new FlightStatusError(
        'Stopping this flight took too long. Check your connection and try again.',
        'unavailable',
      )
    }
    if (options.signal?.aborted) {
      throw new FlightStatusError('Stopping this flight was cancelled.', 'cancelled')
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}

export async function subscribeToFamilyFlights(onChange: () => void) {
  const context = await familyContext()
  if (!context) return () => undefined
  const channel = context.client
    .channel(`family-flights:${context.circleId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'family_flights',
        filter: `circle_id=eq.${context.circleId}`,
      },
      onChange,
    )
    .subscribe()
  return () => {
    void context.client.removeChannel(channel)
  }
}

export function createTrackedFlightId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16)
    const value = character === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}
