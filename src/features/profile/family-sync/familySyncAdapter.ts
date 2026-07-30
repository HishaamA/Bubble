import { supabase } from '../../../lib/supabase'
import type {
  CreatedCircleInvite,
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

function getDisplayName(
  profileData: unknown,
  email: string,
  metadata: UnknownRecord,
) {
  const profile = asRecord(profileData)
  const profileName = profile?.display_name
  if (typeof profileName === 'string' && profileName.trim()) {
    return profileName.trim()
  }

  const metadataName = metadata.display_name
  if (typeof metadataName === 'string' && metadataName.trim()) {
    return metadataName.trim()
  }

  return email.split('@')[0] || 'Family member'
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
  if (message.includes('invalid_invite_code')) {
    return 'That invite code is not valid.'
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
  if (!supabase) return null

  const { data: sessionData, error: sessionError } =
    await supabase.auth.getSession()
  if (sessionError) throw sessionError

  const user = sessionData.session?.user
  if (!user) return null

  const email = user.email ?? ''
  const { data: profileData, error: profileError } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle()
  if (profileError) throw profileError

  return {
    person: {
      id: user.id,
      email,
      displayName: getDisplayName(
        profileData,
        email,
        asRecord(user.user_metadata) ?? {},
      ),
    },
    userId: user.id,
  }
}

async function loadSnapshot(): Promise<FamilySyncSnapshot> {
  if (!supabase) return { kind: 'local-only' }

  const authenticated = await getAuthenticatedPerson()
  if (!authenticated) return { kind: 'signed-out' }

  const { data: membershipData, error: membershipError } = await supabase
    .from('circle_members')
    .select('circle_id,role')
    .eq('user_id', authenticated.userId)
    .eq('status', 'approved')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (membershipError) throw membershipError

  const membership = asRecord(membershipData)
  if (!membership) {
    const { data: pendingData, error: pendingError } = await supabase
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

  const circleId = requireString(membership, 'circle_id')
  const role = membership.role === 'owner' ? 'owner' : 'member'
  const [circleResult, membersResult] = await Promise.all([
    supabase.from('circles').select('id,name').eq('id', circleId).single(),
    supabase
      .from('circle_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('circle_id', circleId)
      .eq('status', 'approved'),
  ])
  if (circleResult.error) throw circleResult.error
  if (membersResult.error) throw membersResult.error

  const circle = asRecord(circleResult.data)
  if (!circle) throw new Error('Family circle details could not be loaded.')

  let pendingRequests: Array<{
    id: string
    requesterId: string
    createdAt: string
  }> = []

  if (role === 'owner') {
    const { data, error } = await supabase
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
      name: requireString(circle, 'name'),
      role,
      memberCount: membersResult.count ?? 1,
    },
    pendingRequests,
  }
}

export const familySyncAdapter: FamilySyncAdapter = {
  loadSnapshot,

  subscribeToAuthChanges(onChange) {
    if (!supabase) return () => undefined
    const { data } = supabase.auth.onAuthStateChange(() => onChange())
    return () => data.subscription.unsubscribe()
  },

  async signIn(email, password) {
    if (!supabase) throw new Error('Family Sync is not configured.')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  },

  async signUp(email, password, displayName) {
    if (!supabase) throw new Error('Family Sync is not configured.')
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName.trim() } },
    })
    if (error) throw error
    return { requiresEmailConfirmation: !data.session }
  },

  async signOut() {
    if (!supabase) return
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  },

  async createCircle(name) {
    if (!supabase) throw new Error('Family Sync is not configured.')
    const authenticated = await getAuthenticatedPerson()
    if (!authenticated) throw new Error('Sign in before creating a circle.')

    const { error } = await supabase.from('circles').insert({
      name: name.trim(),
      owner_id: authenticated.userId,
    })
    if (error) throw error
  },

  async requestCircleJoin(inviteCode) {
    if (!supabase) throw new Error('Family Sync is not configured.')
    const { error } = await supabase.rpc('request_circle_join', {
      p_invite_code: inviteCode.trim(),
    })
    if (error) throw error
  },

  async createCircleInvite(circleId): Promise<CreatedCircleInvite> {
    if (!supabase) throw new Error('Family Sync is not configured.')
    const { data, error } = await supabase.rpc('create_circle_invite', {
      p_circle_id: circleId,
      p_expires_in: '7 days',
      p_max_uses: 1,
    })
    if (error) throw error

    const record = asRecord(Array.isArray(data) ? data[0] : data)
    if (!record) throw new Error('The invite could not be created.')

    return {
      circleId,
      code: requireString(record, 'invite_code'),
      expiresAt: requireString(record, 'expires_at'),
      maxUses:
        typeof record.max_uses === 'number' ? record.max_uses : 1,
    }
  },

  async decideJoinRequest(requestId, decision) {
    if (!supabase) throw new Error('Family Sync is not configured.')
    const { error } = await supabase.rpc('decide_join_request', {
      p_request_id: requestId,
      p_decision: decision,
    })
    if (error) throw error
  },
}
