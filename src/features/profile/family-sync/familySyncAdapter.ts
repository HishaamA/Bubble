import {
  getClerkSupabaseIdentity,
  getSupabaseClient,
  signOutClerkSupabaseSession,
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

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' ? (value as UnknownRecord) : null
}

function requireString(record: UnknownRecord, key: string) {
  const value = record[key]
  if (typeof value !== 'string' || !value) {
    throw new Error('Family Sync returned an incomplete response.')
  }
  return value
}

export const FAMILY_SYNC_REFRESH_EVENT = 'kinsphere:family-sync-refresh'

export function announceFamilySyncChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FAMILY_SYNC_REFRESH_EVENT))
  }
}

export function toFamilySyncErrorMessage(reason: unknown) {
  const rawMessage =
    reason instanceof Error
      ? reason.message
      : asRecord(reason) && typeof asRecord(reason)?.message === 'string'
        ? String(asRecord(reason)?.message)
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

  return rawMessage || 'Family Sync could not complete that request.'
}

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

async function loadSnapshot(): Promise<FamilySyncSnapshot> {
  const client = getSupabaseClient()
  if (!client) return { kind: 'local-only' }

  const authenticated = await getAuthenticatedPerson()
  if (!authenticated) return { kind: 'signed-out' }

  const membership = await readFamilyMembership()
  if (membership.kind !== 'member') {
    const { data: pendingData, error: pendingError } = await client
      .from('join_requests')
      .select('id,created_at')
      .eq('requester_id', authenticated.userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (pendingError) throw pendingError

    const pending = asRecord(pendingData)
    return {
      kind: 'unjoined',
      person: authenticated.person,
      pendingRequest: pending
        ? {
            id: requireString(pending, 'id'),
            createdAt: requireString(pending, 'created_at'),
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
    const { data, error } = await client
      .from('join_requests')
      .select('id,requester_id,created_at')
      .eq('circle_id', circleId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
    if (error) throw error

    pendingRequests = (data ?? []).map((value) => {
      const request = asRecord(value)
      if (!request) throw new Error('A join request could not be loaded.')
      return {
        id: requireString(request, 'id'),
        requesterId: requireString(request, 'requester_id'),
        createdAt: requireString(request, 'created_at'),
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

export const familySyncAdapter: FamilySyncAdapter = {
  loadSnapshot,

  subscribeToAuthChanges(onChange) {
    return subscribeToSupabaseAuthChanges(onChange)
  },

  async signIn() {
    throw new Error('Use the main Clerk sign-in page.')
  },

  async signUp() {
    throw new Error('Use the main Clerk sign-up page.')
  },

  async signOut() {
    await signOutClerkSupabaseSession()
  },

  async createCircle(name) {
    await createFamily(name)
  },

  async requestCircleJoin(inviteCode) {
    await joinFamilyByCode(inviteCode)
  },

  async rotateFamilyCode(circleId) {
    return rotateFamilyShareCode(circleId)
  },

  async decideJoinRequest(requestId, decision) {
    const client = getSupabaseClient()
    if (!client) throw new Error('Family Sync is not configured.')
    const { error } = await client.rpc('decide_join_request', {
      p_request_id: requestId,
      p_decision: decision,
    })
    if (error) throw error
  },
}
