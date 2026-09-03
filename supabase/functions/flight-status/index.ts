import { createClient } from 'npm:@supabase/supabase-js@2.112.4'
import {
  AeroDataBoxProviderError,
  aerodataboxLookup,
  aerodataboxStatus,
} from './aerodataboxProvider.ts'
import {
  isAllowedFlightTrackerOrigin,
  isLikelyAirlineTicketNumber,
  normalizeAirlineFlightNumber,
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

const maximumRequestBodyBytes = 2_048

/** Narrows untrusted JSON without accepting arrays or null. */
function asJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

/** Trims non-empty request text and rejects every other JSON value. */
function normalizedText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Reads either the default hosted key or the first configured project key. */
function readNamedProjectKey(environmentVariable: string) {
  const serializedKeys = Deno.env.get(environmentVariable)
  if (!serializedKeys) return null
  try {
    const keys = asJsonObject(JSON.parse(serializedKeys) as unknown)
    if (!keys) return null
    const preferred = normalizedText(keys.default)
    if (preferred) return preferred
    return Object.values(keys)
      .map(normalizedText)
      .find((key) => key !== null) ?? null
  } catch {
    return null
  }
}

/** Returns the same no-store CORS policy for success and error responses. */
function corsResponseHeaders(request: Request) {
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

/** Serializes one JSON response with the endpoint's CORS policy. */
function jsonResponse(
  request: Request,
  responseBody: JsonObject,
  statusCode = 200,
) {
  return new Response(JSON.stringify(responseBody), {
    status: statusCode,
    headers: {
      ...corsResponseHeaders(request),
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}

function requestOriginIsAllowed(request: Request) {
  return isAllowedFlightTrackerOrigin(
    request.headers.get('Origin'),
    Deno.env.get('APP_ALLOWED_ORIGINS') ?? null,
  )
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** Returns a provider identity only when it matches the server-generated form. */
function normalizeProviderFlightId(value: unknown) {
  const candidate = normalizedText(value)
  if (!candidate || candidate.length > 160) return null
  return /^[A-Z0-9]+:[0-9T:.Z+-]+$/.test(candidate)
    ? candidate
    : null
}

/**
 * Authenticates the Clerk bearer token through PostgREST and atomically spends
 * one member/family rate-limit allowance before any paid provider request.
 */
async function authorizeFamilyFlightLookup(
  request: Request,
): Promise<MemberContext | null> {
  const authorization = request.headers.get('Authorization')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const publishableKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
    ?? readNamedProjectKey('SUPABASE_PUBLISHABLE_KEYS')
    ?? Deno.env.get('SUPABASE_ANON_KEY')
  if (!authorization?.startsWith('Bearer ') || !supabaseUrl || !publishableKey) {
    return null
  }
  const authenticatedClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await authenticatedClient.rpc(
    'begin_family_flight_lookup',
  )
  if (error) {
    if (error.message?.includes('family_flight_rate_limited')) {
      throw new Error('family-flight-rate-limited')
    }
    return null
  }
  const memberRecord = asJsonObject(data)
  const userId = normalizedText(memberRecord?.user_id)
  const circleId = normalizedText(memberRecord?.circle_id)
  return userId && circleId ? { userId, circleId } : null
}

/** Builds the server-only client used after caller authorization succeeds. */
function createServiceClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const secretKey = Deno.env.get('SUPABASE_SECRET_KEY')
    ?? readNamedProjectKey('SUPABASE_SECRET_KEYS')
    ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !secretKey) return null
  return createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Reads the immutable flight identity inside the authorized family boundary. */
async function readStoredFlightIdentity(
  databaseClient: ReturnType<typeof createClient>,
  flightId: string,
  memberContext: MemberContext,
): Promise<StoredFlightIdentity | null> {
  const { data, error } = await databaseClient
    .from('family_flights')
    .select('id,circle_id,created_by,traveler_name,flight_number,travel_date,status_snapshot')
    .eq('id', flightId)
    .maybeSingle()
  if (error) throw new Error('flight-storage-unavailable')
  if (!data || data.circle_id !== memberContext.circleId) return null
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

/** Rechecks membership after the external request to close revocation races. */
async function membershipRemainsApproved(
  databaseClient: ReturnType<typeof createClient>,
  memberContext: MemberContext,
) {
  const { data, error } = await databaseClient
    .from('circle_members')
    .select('circle_id')
    .eq('circle_id', memberContext.circleId)
    .eq('user_id', memberContext.userId)
    .eq('status', 'approved')
    .maybeSingle()
  if (error) throw new Error('flight-storage-unavailable')
  return data?.circle_id === memberContext.circleId
}

function hasSameFlightIdentity(
  left: StoredFlightIdentity,
  right: StoredFlightIdentity,
) {
  return left.id === right.id
    && left.circleId === right.circleId
    && left.createdBy === right.createdBy
    && left.travelerName === right.travelerName
    && left.flightNumber === right.flightNumber
    && left.travelDate === right.travelDate
}

type RequestBodyResult =
  | { kind: 'valid'; requestBody: JsonObject }
  | { kind: 'invalid' }
  | { kind: 'too-large' }

/**
 * Enforces the byte limit even for chunked requests without Content-Length.
 * Measuring the parsed object's character count would undercount UTF-8 input.
 */
async function readRequestBody(request: Request): Promise<RequestBodyResult> {
  const declaredLength = Number(request.headers.get('Content-Length'))
  if (
    Number.isFinite(declaredLength)
    && declaredLength > maximumRequestBodyBytes
  ) {
    return { kind: 'too-large' }
  }

  let serializedBody: string
  try {
    serializedBody = await request.text()
  } catch {
    return { kind: 'invalid' }
  }
  if (
    new TextEncoder().encode(serializedBody).byteLength
      > maximumRequestBodyBytes
  ) {
    return { kind: 'too-large' }
  }

  try {
    const requestBody = asJsonObject(JSON.parse(serializedBody) as unknown)
    return requestBody ? { kind: 'valid', requestBody } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

/** Hides provider internals while preserving actionable HTTP status classes. */
function providerFailureResponse(
  request: Request,
  error: AeroDataBoxProviderError,
) {
  switch (error.code) {
    case 'auth':
      return jsonResponse(request, {
        error: 'Live flight tracking is not configured correctly.',
      }, 503)
    case 'plan':
      return jsonResponse(request, { error: error.message }, 503)
    case 'quota':
      return jsonResponse(request, {
        error: 'The monthly AeroDataBox request quota has been reached.',
      }, 429)
    case 'rate':
      return jsonResponse(request, {
        error: 'Flight updates are busy. Try again shortly.',
      }, 429)
    case 'incomplete':
      return jsonResponse(request, {
        error: 'AeroDataBox returned incomplete flight or airport details.',
      }, 502)
    default:
      return jsonResponse(request, {
        error: 'AeroDataBox is temporarily unavailable.',
      }, 502)
  }
}

/** Coordinates validation, authorization, provider lookup, and persistence. */
async function handleFlightStatusRequest(request: Request) {
  if (!requestOriginIsAllowed(request)) {
    return jsonResponse(request, { error: 'Origin is not allowed.' }, 403)
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsResponseHeaders(request),
    })
  }
  if (request.method !== 'POST') {
    return jsonResponse(request, { error: 'Method not allowed.' }, 405)
  }

  const parsedBody = await readRequestBody(request)
  if (parsedBody.kind === 'too-large') {
    return jsonResponse(request, { error: 'Request is too large.' }, 413)
  }
  if (parsedBody.kind === 'invalid') {
    return jsonResponse(request, { error: 'Send a valid JSON request.' }, 400)
  }
  const { requestBody } = parsedBody

  const operation = requestBody.operation === 'create'
    || requestBody.operation === 'refresh'
    ? requestBody.operation
    : null
  const flightId = isUuid(requestBody.flightId) ? requestBody.flightId : null
  if (!operation || !flightId) {
    return jsonResponse(request, {
      error: 'Enter a valid flight request.',
    }, 422)
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
  if (Object.keys(requestBody).some((key) => !allowedKeys.has(key))) {
    return jsonResponse(request, {
      error: 'The flight request contains unsupported fields.',
    }, 422)
  }

  let memberContext: MemberContext | null
  try {
    memberContext = await authorizeFamilyFlightLookup(request)
  } catch (error) {
    if (error instanceof Error && error.message === 'family-flight-rate-limited') {
      return jsonResponse(request, {
        error: 'Too many flight updates. Wait a few minutes and try again.',
      }, 429)
    }
    memberContext = null
  }
  if (!memberContext) {
    return jsonResponse(request, {
      error: 'An approved family connection is required.',
    }, 401)
  }

  const databaseClient = createServiceClient()
  if (!databaseClient) {
    return jsonResponse(request, {
      error: 'Flight storage is not configured.',
    }, 503)
  }

  let flightIdentity: StoredFlightIdentity | null = null
  try {
    if (operation === 'refresh') {
      flightIdentity = await readStoredFlightIdentity(
        databaseClient,
        flightId,
        memberContext,
      )
      if (!flightIdentity) {
        return jsonResponse(request, {
          error: 'That family flight is no longer available.',
        }, 404)
      }
    } else {
      const travelerName = normalizedText(requestBody.travelerName)
        ?.replace(/\s+/g, ' ') ?? null
      const flightNumber = normalizeAirlineFlightNumber(
        requestBody.flightNumber,
      )
      const providerFlightId = requestBody.providerFlightId === undefined
        ? null
        : normalizeProviderFlightId(requestBody.providerFlightId)
      if (isLikelyAirlineTicketNumber(requestBody.flightNumber)) {
        return jsonResponse(request, {
          error: 'Public flight trackers cannot resolve a 13-digit ticket number. Enter the airline flight number and travel date; ticket numbers are never stored.',
        }, 422)
      }
      const clientCalendarDate = validClientCalendarDate(
        requestBody.clientCalendarDate,
      )
      const travelDate = clientCalendarDate
        ? validTravelDateForCalendar(
            requestBody.travelDate,
            clientCalendarDate,
          )
        : null
      if (
        !travelerName
        || travelerName.length > 60
        || !flightNumber
        || !travelDate
        || (requestBody.providerFlightId !== undefined && !providerFlightId)
      ) {
        return jsonResponse(request, {
          error: 'Enter a valid traveler, flight number, and travel date.',
        }, 422)
      }

      const existingFlight = await readStoredFlightIdentity(
        databaseClient,
        flightId,
        memberContext,
      )
      if (existingFlight) {
        const existingProviderFlightId = normalizedText(
          asJsonObject(existingFlight.previousSnapshot)?.providerFlightId,
        )
        if (
          existingFlight.createdBy !== memberContext.userId
          || existingFlight.flightNumber !== flightNumber
          || existingFlight.travelDate !== travelDate
          || existingFlight.travelerName !== travelerName
          || (
            providerFlightId
            && existingProviderFlightId
            && providerFlightId !== existingProviderFlightId
          )
        ) {
          return jsonResponse(request, {
            error: 'That flight request conflicts with an existing record.',
          }, 409)
        }
        flightIdentity = existingFlight
      } else {
        flightIdentity = {
          id: flightId,
          circleId: memberContext.circleId,
          createdBy: memberContext.userId,
          travelerName,
          flightNumber,
          travelDate,
          previousSnapshot: null,
        }
      }
    }

    const apiKey = Deno.env.get('AERODATABOX_RAPIDAPI_KEY')
    if (!apiKey) {
      return jsonResponse(request, {
        error: 'Live flight tracking is not configured.',
      }, 503)
    }
    const selectedProviderFlightId = operation === 'create'
      ? normalizeProviderFlightId(requestBody.providerFlightId)
      : null
    const lookupResult = operation === 'create'
      ? await aerodataboxLookup(
          flightIdentity.flightNumber,
          flightIdentity.travelDate,
          apiKey,
          flightIdentity.previousSnapshot,
          selectedProviderFlightId,
        )
      : null
    if (lookupResult?.kind === 'choices') {
      if (!await membershipRemainsApproved(databaseClient, memberContext)) {
        return jsonResponse(request, {
          error: 'An approved family connection is required.',
        }, 403)
      }
      return jsonResponse(request, {
        kind: 'choices',
        choices: lookupResult.choices,
      })
    }
    const statusSnapshot = operation === 'create'
      ? lookupResult?.kind === 'created' ? lookupResult.snapshot : null
      : await aerodataboxStatus(
          flightIdentity.flightNumber,
          flightIdentity.travelDate,
          apiKey,
          flightIdentity.previousSnapshot,
        )
    if (!statusSnapshot) {
      return jsonResponse(request, {
        error: selectedProviderFlightId
          ? 'That flight choice no longer matches the selected departure date. Search again.'
          : 'No flight was found for that number on the selected departure date.',
      }, 404)
    }

    // Provider calls happen outside the database transaction, so authorization
    // and immutable identity are checked again before any service-role write.
    if (!await membershipRemainsApproved(databaseClient, memberContext)) {
      return jsonResponse(request, {
        error: 'An approved family connection is required.',
      }, 403)
    }
    const currentIdentity = await readStoredFlightIdentity(
      databaseClient,
      flightId,
      memberContext,
    )
    if (
      currentIdentity
      && !hasSameFlightIdentity(currentIdentity, flightIdentity)
    ) {
      return jsonResponse(request, {
        error: 'That flight request conflicts with an existing record.',
      }, 409)
    }
    if (operation === 'refresh' && !currentIdentity) {
      return jsonResponse(request, {
        error: 'That family flight is no longer available.',
      }, 404)
    }

    if (operation === 'create') {
      const persistenceResult = currentIdentity
        ? await databaseClient
          .from('family_flights')
          .update({
            status_snapshot: statusSnapshot,
            status_updated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', flightId)
          .eq('circle_id', memberContext.circleId)
          .eq('created_by', memberContext.userId)
          .eq('flight_number', flightIdentity.flightNumber)
          .eq('travel_date', flightIdentity.travelDate)
          .select('id')
          .maybeSingle()
        : await databaseClient.from('family_flights').insert({
          id: flightIdentity.id,
          circle_id: flightIdentity.circleId,
          created_by: flightIdentity.createdBy,
          traveler_name: flightIdentity.travelerName,
          flight_number: flightIdentity.flightNumber,
          travel_date: flightIdentity.travelDate,
          status_snapshot: statusSnapshot,
        })
      if (
        persistenceResult.error
        || (currentIdentity && !persistenceResult.data)
      ) {
        throw new Error('flight-storage-unavailable')
      }
    } else {
      const { data, error } = await databaseClient
        .from('family_flights')
        .update({
          status_snapshot: statusSnapshot,
          status_updated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', flightIdentity.id)
        .eq('circle_id', flightIdentity.circleId)
        .eq('created_by', flightIdentity.createdBy)
        .eq('flight_number', flightIdentity.flightNumber)
        .eq('travel_date', flightIdentity.travelDate)
        .select('id')
        .maybeSingle()
      if (error || !data) throw new Error('flight-storage-unavailable')
    }
    return jsonResponse(request, operation === 'create'
      ? { kind: 'created', snapshot: statusSnapshot }
      : statusSnapshot)
  } catch (error) {
    if (error instanceof AeroDataBoxProviderError) {
      return providerFailureResponse(request, error)
    }
    return jsonResponse(request, {
      error: 'The flight provider or secure storage is temporarily unavailable.',
    }, 502)
  }
}

Deno.serve(handleFlightStatusRequest)
