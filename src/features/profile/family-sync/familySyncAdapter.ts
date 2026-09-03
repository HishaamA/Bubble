import {
  getClerkSupabaseIdentity,
  getSupabaseClient,
  subscribeToSupabaseAuthChanges,
} from '../../../lib/supabase'
import {
  bootstrapCurrentClerkProfile,
  createFamily,
  joinFamilyByCode,
  readFamilyMembership,
  rotateFamilyShareCode,
} from '../../../services/persistence'
import type {
  FamilySyncAdapter,
  FamilySyncPerson,
  FamilySyncSnapshot,
} from './types'

type UnknownRecord = Record<string, unknown>

/** Narrows untrusted backend payloads before individual fields are read. */
function asRecord(candidate: unknown): UnknownRecord | null {
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as UnknownRecord)
    : null
}

/** Reads a required non-empty string or fails the whole inconsistent snapshot. */
function requireString(record: UnknownRecord, fieldName: string) {
  const fieldValue = record[fieldName]
  if (typeof fieldValue !== 'string' || !fieldValue) {
    throw new Error('Family Sync returned an incomplete response.')
  }
  return fieldValue
}

/** Browser event used to revalidate family membership after a mutation. */
export const FAMILY_SYNC_REFRESH_EVENT = 'kinsphere:family-sync-refresh'

/** Notifies other mounted family consumers that their snapshot may be stale. */
export function announceFamilySyncChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FAMILY_SYNC_REFRESH_EVENT))
  }
}

/** Maps backend and network failures to safe, actionable interface copy. */
export function toFamilySyncErrorMessage(errorReason: unknown) {
  const errorRecord = asRecord(errorReason)
  const rawMessage =
    errorReason instanceof Error
      ? errorReason.message
      : typeof errorRecord?.message === 'string'
        ? errorRecord.message
        : ''
  const errorCode =
    typeof errorRecord?.code === 'string'
      ? errorRecord.code.toLowerCase()
      : ''
  const message = rawMessage.toLowerCase()

  if (message.includes('invalid login credentials')) {
    return 'That email and password do not match.'
  }
  if (message.includes('email not confirmed')) {
    return 'Confirm your email before signing in.'
  }
  if (message.includes('user already registered')) {
    return 'An account already exists for that email.'
  }
  if (
    message.includes('invalid_invite_code') ||
    message.includes('invalid_family_code') ||
    message.includes('family_code_not_found')
  ) {
    return 'That family code is not valid.'
  }
  if (message.includes('invite_not_available')) {
    return 'That invite has expired, was revoked, or has already been used.'
  }
  if (message.includes('already_a_member')) {
    return 'You are already connected to that family circle.'
  }
  if (message.includes('join_request_not_pending')) {
    return 'That request has already been handled. Refresh to see the latest list.'
  }
  if (message.includes('circle_owner_required')) {
    return 'Only the family circle owner can do that.'
  }
  if (message.includes('password')) {
    return 'Use a stronger password with at least 8 characters.'
  }
  if (message.includes('network') || message.includes('fetch')) {
    return 'Family Sync could not reach the server. Check your connection and try again.'
  }
  if (
    errorCode === '42501' ||
    message.includes('permission') ||
    message.includes('row-level security')
  ) {
    return 'Your family access may have changed. Sign in again or ask the family owner.'
  }
  if (message.includes('jwt') || message.includes('session')) {
    return 'Your secure session needs to be renewed. Sign in again to continue.'
  }

  // Database and authentication errors can contain implementation details.
  // Unknown server copy must not be rendered directly into the settings page.
  return 'Family Sync could not complete that request.'
}

/** Resolves the Clerk-backed Supabase identity used by every family query. */
async function getAuthenticatedPerson(): Promise<{
  person: FamilySyncPerson
  userId: string
} | null> {
  if (!getSupabaseClient()) return null
  const identity = getClerkSupabaseIdentity()
  if (!identity) return null
  const profile = await bootstrapCurrentClerkProfile()

  return {
    person: {
      id: profile.userId,
      email: profile.email ?? identity.email ?? '',
      displayName: profile.displayName,
    },
    userId: profile.userId,
  }
}

/** Loads one coherent panel snapshot instead of exposing query-level state. */
async function loadSnapshot(): Promise<FamilySyncSnapshot> {
  const client = getSupabaseClient()
  if (!client) return { kind: 'local-only' }

  const authenticated = await getAuthenticatedPerson()
  if (!authenticated) return { kind: 'signed-out' }

  const membership = await readFamilyMembership()
  if (membership.kind !== 'member') {
    const { data: pendingRequestData, error: pendingRequestError } = await client
      .from('join_requests')
      .select('id,created_at')
      .eq('requester_id', authenticated.userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (pendingRequestError) throw pendingRequestError

    const pendingRequestRecord = asRecord(pendingRequestData)
    return {
      kind: 'unjoined',
      person: authenticated.person,
      pendingRequest: pendingRequestRecord
        ? {
            id: requireString(pendingRequestRecord, 'id'),
            createdAt: requireString(
              pendingRequestRecord,
              'created_at',
            ),
          }
        : null,
    }
  }

  const circleId = membership.circleId
  const role = membership.role
  if (!membership.shareCode) {
    throw new Error('The family share code could not be loaded.')
  }

  let pendingRequests: Array<{
    id: string
    requesterId: string
    createdAt: string
  }> = []

  if (role === 'owner') {
    const { data: requestData, error: requestError } = await client
      .from('join_requests')
      .select('id,requester_id,created_at')
      .eq('circle_id', circleId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
    if (requestError) throw requestError

    pendingRequests = (requestData ?? []).map((requestValue) => {
      const requestRecord = asRecord(requestValue)
      if (!requestRecord) {
        throw new Error('A join request could not be loaded.')
      }
      return {
        id: requireString(requestRecord, 'id'),
        requesterId: requireString(requestRecord, 'requester_id'),
        createdAt: requireString(requestRecord, 'created_at'),
      }
    })
  }

  return {
    kind: 'connected',
    person: authenticated.person,
    circle: {
      id: circleId,
      name: membership.circleName,
      role,
      memberCount: membership.memberCount,
      shareCode: membership.shareCode,
    },
    pendingRequests,
  }
}

/** Production family-sync persistence backed by the active Supabase session. */
export const familySyncAdapter: FamilySyncAdapter = {
  loadSnapshot,

  /** Revalidates the panel whenever the authenticated Supabase identity changes. */
  subscribeToAuthChanges(onChange) {
    return subscribeToSupabaseAuthChanges(onChange)
  },

  /** Creates a family for the current authenticated profile. */
  async createCircle(name) {
    await createFamily(name)
  },

  /** Resolves both current persistent codes and supported legacy invites. */
  async requestCircleJoin(inviteCode) {
    await joinFamilyByCode(inviteCode)
  },

  /** Invalidates the old share code and returns its replacement. */
  async rotateFamilyCode(circleId) {
    return rotateFamilyShareCode(circleId)
  },

  /** Applies an owner decision through the policy-enforced database function. */
  async decideJoinRequest(requestId, decision) {
    const client = getSupabaseClient()
    if (!client) throw new Error('Family Sync is not configured.')
    const { error: requestError } = await client.rpc('decide_join_request', {
      p_request_id: requestId,
      p_decision: decision,
    })
    if (requestError) throw requestError
  },
}
