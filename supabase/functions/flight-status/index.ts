import { createClient } from 'npm:@supabase/supabase-js@2.112.4'
import {
  AeroDataBoxProviderError,
  aerodataboxLookup,
  aerodataboxStatus,
} from './aerodataboxProvider.ts'
import {
  isAllowedFlightTrackerOrigin,
  validClientCalendarDate,
  validTravelDateForCalendar,
} from './providerHelpers.ts'

type JsonObject = Record<string, unknown>
type MemberContext = { userId: string; circleId: string }
type StoredFlightIdentity = {
  id: string
  circleId: string
  createdBy: string
  travelerName: string
  flightNumber: string
  travelDate: string
  previousSnapshot: unknown
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function namedProjectKey(variable: string) {
  const raw = Deno.env.get(variable)
  if (!raw) return null
  try {
    const keys = object(JSON.parse(raw) as unknown)
    if (!keys) return null
    const preferred = text(keys.default)
    if (preferred) return preferred
    return Object.values(keys).map(text).find((key) => key !== null) ?? null
  } catch {
    return null
  }
}

function corsHeaders(request: Request) {
  const origin = request.headers.get('Origin')
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'private, no-store',
    Vary: 'Origin',
  }
  if (origin && isAllowedFlightTrackerOrigin(
    origin,
    Deno.env.get('APP_ALLOWED_ORIGINS') ?? null,
  )) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

function json(request: Request, body: JsonObject, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}

function isAllowedOrigin(request: Request) {
  return isAllowedFlightTrackerOrigin(
    request.headers.get('Origin'),
    Deno.env.get('APP_ALLOWED_ORIGINS') ?? null,
  )
}

function normalizedFlightNumber(value: unknown) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '')
  if (/^\d{13}$/.test(normalized)) return 'ticket'
  if (
    !/^[A-Z0-9]{3,8}$/.test(normalized)
    || !/[A-Z]/.test(normalized)
    || !/\d/.test(normalized)
  ) return null
  return normalized
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function validProviderFlightId(value: unknown) {
  const candidate = text(value)
  if (!candidate || candidate.length > 160) return null
  return /^[A-Z0-9]+:[0-9T:.Z+-]+$/.test(candidate)
    ? candidate
    : null
}

async function authorizeLookup(request: Request): Promise<MemberContext | null> {
  const authorization = request.headers.get('Authorization')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const publishableKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
    ?? namedProjectKey('SUPABASE_PUBLISHABLE_KEYS')
    ?? Deno.env.get('SUPABASE_ANON_KEY')
  if (!authorization?.startsWith('Bearer ') || !supabaseUrl || !publishableKey) {
    return null
  }
  const client = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.rpc('begin_family_flight_lookup')
  if (error) {
    if (error.message?.includes('family_flight_rate_limited')) {
      throw new Error('family-flight-rate-limited')
    }
    return null
  }
  const result = object(data)
  const userId = text(result?.user_id)
  const circleId = text(result?.circle_id)
  return userId && circleId ? { userId, circleId } : null
}

function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SECRET_KEY')
    ?? namedProjectKey('SUPABASE_SECRET_KEYS')
    ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return null
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function storedFlightIdentity(
  client: ReturnType<typeof createClient>,
  flightId: string,
  context: MemberContext,
): Promise<StoredFlightIdentity | null> {
  const { data, error } = await client
    .from('family_flights')
    .select('id,circle_id,created_by,traveler_name,flight_number,travel_date,status_snapshot')
    .eq('id', flightId)
    .maybeSingle()
  if (error) throw new Error('flight-storage-unavailable')
  if (!data || data.circle_id !== context.circleId) return null
  return {
    id: data.id as string,
    circleId: data.circle_id as string,
    createdBy: data.created_by as string,
    travelerName: data.traveler_name as string,
    flightNumber: data.flight_number as string,
    travelDate: data.travel_date as string,
    previousSnapshot: data.status_snapshot,
  }
}

async function membershipStillApproved(
  client: ReturnType<typeof createClient>,
  context: MemberContext,
) {
  const { data, error } = await client
    .from('circle_members')
    .select('circle_id')
    .eq('circle_id', context.circleId)
    .eq('user_id', context.userId)
    .eq('status', 'approved')
    .maybeSingle()
  if (error) throw new Error('flight-storage-unavailable')
  return data?.circle_id === context.circleId
}

function sameFlightIdentity(left: StoredFlightIdentity, right: StoredFlightIdentity) {
  return left.id === right.id
    && left.circleId === right.circleId
    && left.createdBy === right.createdBy
    && left.travelerName === right.travelerName
    && left.flightNumber === right.flightNumber
    && left.travelDate === right.travelDate
}

function providerErrorResponse(request: Request, error: AeroDataBoxProviderError) {
  switch (error.code) {
    case 'auth':
      return json(request, {
        error: 'Live flight tracking is not configured correctly.',
      }, 503)
    case 'plan':
      return json(request, { error: error.message }, 503)
    case 'quota':
      return json(request, {
        error: 'The monthly AeroDataBox request quota has been reached.',
      }, 429)
    case 'rate':
      return json(request, {
        error: 'Flight updates are busy. Try again shortly.',
      }, 429)
    case 'incomplete':
      return json(request, {
        error: 'AeroDataBox returned incomplete flight or airport details.',
      }, 502)
    default:
      return json(request, {
        error: 'AeroDataBox is temporarily unavailable.',
      }, 502)
  }
}

Deno.serve(async (request) => {
  if (!isAllowedOrigin(request)) {
    return json(request, { error: 'Origin is not allowed.' }, 403)
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) })
  }
  if (request.method !== 'POST') {
    return json(request, { error: 'Method not allowed.' }, 405)
  }
  if ((Number(request.headers.get('Content-Length')) || 0) > 2_048) {
    return json(request, { error: 'Request is too large.' }, 413)
  }

  let body: JsonObject
  try {
    body = object(await request.json()) ?? {}
  } catch {
    return json(request, { error: 'Send a valid JSON request.' }, 400)
  }
  if (JSON.stringify(body).length > 2_048) {
    return json(request, { error: 'Request is too large.' }, 413)
  }

  const operation = body.operation === 'create' || body.operation === 'refresh'
    ? body.operation
    : null
  const flightId = validUuid(body.flightId) ? body.flightId : null
  if (!operation || !flightId) {
    return json(request, { error: 'Enter a valid flight request.' }, 422)
  }
  const allowedKeys = new Set(operation === 'create'
    ? [
      'operation',
      'flightId',
      'travelerName',
      'flightNumber',
      'travelDate',
      'clientCalendarDate',
      'providerFlightId',
    ]
    : ['operation', 'flightId'])
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return json(request, {
      error: 'The flight request contains unsupported fields.',
    }, 422)
  }

  let context: MemberContext | null
  try {
    context = await authorizeLookup(request)
  } catch (error) {
    if (error instanceof Error && error.message === 'family-flight-rate-limited') {
      return json(request, {
        error: 'Too many flight updates. Wait a few minutes and try again.',
      }, 429)
    }
    context = null
  }
  if (!context) {
    return json(request, {
      error: 'An approved family connection is required.',
    }, 401)
  }

  const database = serviceClient()
  if (!database) {
    return json(request, { error: 'Flight storage is not configured.' }, 503)
  }

  let identity: StoredFlightIdentity | null = null
  try {
    if (operation === 'refresh') {
      identity = await storedFlightIdentity(database, flightId, context)
      if (!identity) {
        return json(request, {
          error: 'That family flight is no longer available.',
        }, 404)
      }
    } else {
      const travelerName = text(body.travelerName)?.replace(/\s+/g, ' ') ?? null
      const flightNumber = normalizedFlightNumber(body.flightNumber)
      const providerFlightId = body.providerFlightId === undefined
        ? null
        : validProviderFlightId(body.providerFlightId)
      if (flightNumber === 'ticket') {
        return json(request, {
          error: 'Public flight trackers cannot resolve a 13-digit ticket number. Enter the airline flight number and travel date; ticket numbers are never stored.',
        }, 422)
      }
      const clientCalendarDate = validClientCalendarDate(body.clientCalendarDate)
      const travelDate = clientCalendarDate
        ? validTravelDateForCalendar(body.travelDate, clientCalendarDate)
        : null
      if (
        !travelerName
        || travelerName.length > 60
        || !flightNumber
        || !travelDate
        || (body.providerFlightId !== undefined && !providerFlightId)
      ) {
        return json(request, {
          error: 'Enter a valid traveler, flight number, and travel date.',
        }, 422)
      }

      const existing = await storedFlightIdentity(database, flightId, context)
      if (existing) {
        const existingProviderFlightId = text(
          object(existing.previousSnapshot)?.providerFlightId,
        )
        if (
          existing.createdBy !== context.userId
          || existing.flightNumber !== flightNumber
          || existing.travelDate !== travelDate
          || existing.travelerName !== travelerName
          || (
            providerFlightId
            && existingProviderFlightId
            && providerFlightId !== existingProviderFlightId
          )
        ) {
          return json(request, {
            error: 'That flight request conflicts with an existing record.',
          }, 409)
        }
        identity = existing
      } else {
        identity = {
          id: flightId,
          circleId: context.circleId,
          createdBy: context.userId,
          travelerName,
          flightNumber,
          travelDate,
          previousSnapshot: null,
        }
      }
    }

    const apiKey = Deno.env.get('AERODATABOX_RAPIDAPI_KEY')
    if (!apiKey) {
      return json(request, {
        error: 'Live flight tracking is not configured.',
      }, 503)
    }
    const selectedProviderFlightId = operation === 'create'
      ? validProviderFlightId(body.providerFlightId)
      : null
    const lookup = operation === 'create'
      ? await aerodataboxLookup(
          identity.flightNumber,
          identity.travelDate,
          apiKey,
          identity.previousSnapshot,
          selectedProviderFlightId,
        )
      : null
    if (lookup?.kind === 'choices') {
      if (!await membershipStillApproved(database, context)) {
        return json(request, {
          error: 'An approved family connection is required.',
        }, 403)
      }
      return json(request, { kind: 'choices', choices: lookup.choices })
    }
    const status = operation === 'create'
      ? lookup?.kind === 'created' ? lookup.snapshot : null
      : await aerodataboxStatus(
          identity.flightNumber,
          identity.travelDate,
          apiKey,
          identity.previousSnapshot,
        )
    if (!status) {
      return json(request, {
        error: selectedProviderFlightId
          ? 'That flight choice no longer matches the selected departure date. Search again.'
          : 'No flight was found for that number on the selected departure date.',
      }, 404)
    }

    if (!await membershipStillApproved(database, context)) {
      return json(request, {
        error: 'An approved family connection is required.',
      }, 403)
    }
    const currentIdentity = await storedFlightIdentity(database, flightId, context)
    if (currentIdentity && !sameFlightIdentity(currentIdentity, identity)) {
      return json(request, {
        error: 'That flight request conflicts with an existing record.',
      }, 409)
    }
    if (operation === 'refresh' && !currentIdentity) {
      return json(request, {
        error: 'That family flight is no longer available.',
      }, 404)
    }

    if (operation === 'create') {
      const write = currentIdentity
        ? await database
          .from('family_flights')
          .update({
            status_snapshot: status,
            status_updated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', flightId)
          .eq('circle_id', context.circleId)
          .eq('created_by', context.userId)
          .eq('flight_number', identity.flightNumber)
          .eq('travel_date', identity.travelDate)
          .select('id')
          .maybeSingle()
        : await database.from('family_flights').insert({
          id: identity.id,
          circle_id: identity.circleId,
          created_by: identity.createdBy,
          traveler_name: identity.travelerName,
          flight_number: identity.flightNumber,
          travel_date: identity.travelDate,
          status_snapshot: status,
        })
      if (write.error || (currentIdentity && !write.data)) {
        throw new Error('flight-storage-unavailable')
      }
    } else {
      const { data, error } = await database
        .from('family_flights')
        .update({
          status_snapshot: status,
          status_updated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', identity.id)
        .eq('circle_id', identity.circleId)
        .eq('created_by', identity.createdBy)
        .eq('flight_number', identity.flightNumber)
        .eq('travel_date', identity.travelDate)
        .select('id')
        .maybeSingle()
      if (error || !data) throw new Error('flight-storage-unavailable')
    }
    return json(request, operation === 'create'
      ? { kind: 'created', snapshot: status }
      : status)
  } catch (error) {
    if (error instanceof AeroDataBoxProviderError) {
      return providerErrorResponse(request, error)
    }
    return json(request, {
      error: 'The flight provider or secure storage is temporarily unavailable.',
    }, 502)
  }
})
