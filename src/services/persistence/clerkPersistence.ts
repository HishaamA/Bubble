import {
  getClerkSupabaseIdentity,
  getSupabaseClient,
} from '../../lib/supabase'

type UnknownRecord = Record<string, unknown>

export type PersistentProfile = {
  userId: string
  subject: string
  displayName: string
  email: string | null
  onboardingCompleted: boolean
  onboardingCompletedAt: string | null
}

export type OnboardingState = {
  completed: boolean
  completedAt: string | null
}

export type ProfilePreferences = {
  notificationsEnabled: boolean
  quietHoursEnabled: boolean
  quietHoursStart: string | null
  quietHoursEnd: string | null
}

export type ProfilePreferencesPatch = {
  notificationsEnabled?: boolean
  quietHoursEnabled?: boolean
}

export type FamilyMembershipState =
  | {
      kind: 'unjoined'
      userId: string
      pendingRequestId: string | null
    }
  | {
      kind: 'member'
      userId: string
      circleId: string
      circleName: string
      role: 'owner' | 'member'
      ownerId: string
      memberCount: number
      shareCode: string
    }

export type FamilyMember = {
  familyId: string
  userId: string
  displayName: string
  avatarPath: string | null
  role: 'owner' | 'member'
  joinedAt: string
}

export type CreatedFamily = {
  id: string
  name: string
  role: 'owner'
  ownerId: string
  memberCount: number
  shareCode: string
}

export type JoinedFamily = {
  id: string
  name: string
  role: 'owner' | 'member'
  ownerId: string
  memberCount: number
  shareCode: string
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' ? (value as UnknownRecord) : null
}

function firstRecord(value: unknown) {
  return asRecord(Array.isArray(value) ? value[0] : value)
}

function requiredString(record: UnknownRecord, key: string) {
  const value = record[key]
  if (typeof value !== 'string' || !value) {
    throw new Error('Supabase returned an incomplete persistent profile.')
  }
  return value
}

function optionalString(record: UnknownRecord, key: string) {
  const value = record[key]
  return typeof value === 'string' && value ? value : null
}

function requiredNumber(record: UnknownRecord, key: string) {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Supabase returned incomplete family data.')
  }
  return value
}

function familyRole(record: UnknownRecord): 'owner' | 'member' {
  const role = record.family_role
  if (role !== 'owner' && role !== 'member') {
    throw new Error('Supabase returned an invalid family role.')
  }
  return role
}

function familyFromRecord(record: UnknownRecord) {
  return {
    id: requiredString(record, 'family_id'),
    name: requiredString(record, 'family_name'),
    role: familyRole(record),
    ownerId: requiredString(record, 'owner_id'),
    memberCount: requiredNumber(record, 'member_count'),
    shareCode: requiredString(record, 'share_code'),
  }
}

export function normalizeFamilyShareCode(value: string) {
  return value.trim().toUpperCase()
}

function profilePreferencesFromRecord(
  record: UnknownRecord,
): ProfilePreferences {
  const quietHoursStart = optionalString(record, 'quiet_hours_start')
  const quietHoursEnd = optionalString(record, 'quiet_hours_end')
  return {
    notificationsEnabled: record.notifications_enabled === true,
    quietHoursEnabled: Boolean(quietHoursStart && quietHoursEnd),
    quietHoursStart,
    quietHoursEnd,
  }
}

function requireAuthenticatedClient() {
  const client = getSupabaseClient()
  const identity = getClerkSupabaseIdentity()
  if (!client) {
    throw new Error('Persistent family storage is not configured.')
  }
  if (!identity?.subject) {
    throw new Error('Sign in before loading persistent family data.')
  }
  return { client, identity }
}

/**
 * Idempotently maps the verified Clerk JWT subject to Bubble's internal ID.
 * The subject is read by PostgreSQL from auth.jwt(); it is never accepted from
 * this client payload.
 */
export async function bootstrapCurrentClerkProfile(): Promise<PersistentProfile> {
  const { client, identity } = requireAuthenticatedClient()
  const { data, error } = await client.rpc('bootstrap_current_user', {
    p_display_name: identity.displayName?.trim() || null,
    p_email: identity.email?.trim() || null,
  })
  if (error) throw error

  const record = firstRecord(data)
  if (!record) throw new Error('The persistent profile could not be created.')
  const subject = requiredString(record, 'subject')
  if (subject !== identity.subject) {
    throw new Error('The authenticated profile did not match the Clerk session.')
  }

  return {
    userId: requiredString(record, 'user_id'),
    subject,
    displayName: requiredString(record, 'display_name'),
    email: optionalString(record, 'email'),
    onboardingCompleted: record.onboarding_completed === true,
    onboardingCompletedAt: optionalString(
      record,
      'onboarding_completed_at',
    ),
  }
}

export async function readOnboardingState(): Promise<OnboardingState> {
  const profile = await bootstrapCurrentClerkProfile()
  return {
    completed: profile.onboardingCompleted,
    completedAt: profile.onboardingCompletedAt,
  }
}

export async function markTutorialComplete(): Promise<OnboardingState> {
  const { client } = requireAuthenticatedClient()
  await bootstrapCurrentClerkProfile()
  const { data, error } = await client.rpc(
    'complete_current_user_onboarding',
  )
  if (error) throw error
  if (typeof data !== 'string' || Number.isNaN(new Date(data).getTime())) {
    throw new Error('Tutorial completion could not be saved.')
  }
  return { completed: true, completedAt: data }
}

export async function readProfilePreferences(): Promise<ProfilePreferences> {
  const { client } = requireAuthenticatedClient()
  const profile = await bootstrapCurrentClerkProfile()
  const { data, error } = await client
    .from('profile_preferences')
    .select(
      'notifications_enabled,quiet_hours_start,quiet_hours_end',
    )
    .eq('user_id', profile.userId)
    .single()
  if (error) throw error
  const preferences = asRecord(data)
  if (!preferences) {
    throw new Error('Your profile preferences could not be loaded.')
  }
  return profilePreferencesFromRecord(preferences)
}

export async function updateProfilePreferences(
  patch: ProfilePreferencesPatch,
): Promise<ProfilePreferences> {
  const { client } = requireAuthenticatedClient()
  const profile = await bootstrapCurrentClerkProfile()
  const changes: UnknownRecord = {}

  if (typeof patch.notificationsEnabled === 'boolean') {
    changes.notifications_enabled = patch.notificationsEnabled
  }
  if (typeof patch.quietHoursEnabled === 'boolean') {
    changes.quiet_hours_start = patch.quietHoursEnabled ? '22:00:00' : null
    changes.quiet_hours_end = patch.quietHoursEnabled ? '08:00:00' : null
  }
  if (Object.keys(changes).length === 0) {
    return readProfilePreferences()
  }

  const { data, error } = await client
    .from('profile_preferences')
    .update(changes)
    .eq('user_id', profile.userId)
    .select(
      'notifications_enabled,quiet_hours_start,quiet_hours_end',
    )
    .single()
  if (error) throw error
  const preferences = asRecord(data)
  if (!preferences) {
    throw new Error('Your profile preferences could not be saved.')
  }
  return profilePreferencesFromRecord(preferences)
}

export async function readFamilyMembership(): Promise<FamilyMembershipState> {
  const { client } = requireAuthenticatedClient()
  const profile = await bootstrapCurrentClerkProfile()
  const { data: familyData, error: familyError } = await client.rpc(
    'get_current_family',
  )
  if (familyError) throw familyError

  const familyRecord = firstRecord(familyData)
  if (!familyRecord) {
    const { data: pendingData, error: pendingError } = await client
      .from('join_requests')
      .select('id')
      .eq('requester_id', profile.userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (pendingError) throw pendingError
    const pending = asRecord(pendingData)
    return {
      kind: 'unjoined',
      userId: profile.userId,
      pendingRequestId: pending ? requiredString(pending, 'id') : null,
    }
  }

  const family = familyFromRecord(familyRecord)

  return {
    kind: 'member',
    userId: profile.userId,
    circleId: family.id,
    circleName: family.name,
    role: family.role,
    ownerId: family.ownerId,
    memberCount: family.memberCount,
    shareCode: family.shareCode,
  }
}

export async function createFamily(name: string): Promise<CreatedFamily> {
  const normalizedName = name.trim()
  if (!normalizedName || normalizedName.length > 80) {
    throw new Error('Give your family a name of 80 characters or fewer.')
  }

  const { client } = requireAuthenticatedClient()
  await bootstrapCurrentClerkProfile()
  const { data, error } = await client.rpc(
    'create_family_with_share_code',
    { p_name: normalizedName },
  )
  if (error) throw error
  const record = firstRecord(data)
  if (!record) throw new Error('The family group could not be created.')
  const family = familyFromRecord(record)
  if (family.role !== 'owner' || !family.shareCode) {
    throw new Error('The new family share code could not be created.')
  }
  return {
    id: family.id,
    name: family.name,
    role: 'owner',
    ownerId: family.ownerId,
    memberCount: family.memberCount,
    shareCode: family.shareCode,
  }
}

export async function joinFamilyByCode(
  inviteCode: string,
): Promise<JoinedFamily | { requestId: string }> {
  const normalizedCode = normalizeFamilyShareCode(inviteCode)
  const { client } = requireAuthenticatedClient()
  await bootstrapCurrentClerkProfile()

  if (/^BUB-[0-9A-F]{4}(-[0-9A-F]{4}){5}$/.test(normalizedCode)) {
    const { data, error } = await client.rpc(
      'join_family_by_share_code',
      { p_share_code: normalizedCode },
    )
    if (error) throw error
    const record = firstRecord(data)
    if (!record) throw new Error('The family could not be joined.')
    const family = familyFromRecord(record)
    return {
      id: family.id,
      name: family.name,
      role: family.role,
      ownerId: family.ownerId,
      memberCount: family.memberCount,
      shareCode: family.shareCode,
    }
  }

  // Keep previously issued invite links functional during the transition.
  const legacyCode = inviteCode.trim().toLowerCase()
  if (!/^ks1_[0-9a-f]{64}$/.test(legacyCode)) {
    throw new Error('invalid_family_code')
  }
  const { data, error } = await client.rpc('request_circle_join', {
    p_invite_code: legacyCode,
  })
  if (error) throw error
  if (typeof data !== 'string') {
    throw new Error('The family join request could not be saved.')
  }
  return { requestId: data }
}

export async function readFamilyMembers(): Promise<FamilyMember[]> {
  const { client } = requireAuthenticatedClient()
  await bootstrapCurrentClerkProfile()
  const { data, error } = await client.rpc(
    'list_current_family_members',
  )
  if (error) throw error

  if (!Array.isArray(data)) return []
  return data.map((value) => {
    const member = asRecord(value)
    if (!member) throw new Error('A family member could not be loaded.')
    const role = familyRole(member)
    return {
      familyId: requiredString(member, 'family_id'),
      userId: requiredString(member, 'user_id'),
      displayName: requiredString(member, 'display_name'),
      avatarPath: optionalString(member, 'avatar_path'),
      role,
      joinedAt: requiredString(member, 'joined_at'),
    }
  })
}

export async function readFamilyShareCode(circleId: string) {
  const { client } = requireAuthenticatedClient()
  await bootstrapCurrentClerkProfile()
  const { data, error } = await client.rpc(
    'get_or_create_family_share_code',
    { p_circle_id: circleId },
  )
  if (error) throw error
  if (typeof data !== 'string' || !data) {
    throw new Error('The family share code could not be loaded.')
  }
  return data
}

export async function rotateFamilyShareCode(circleId: string) {
  const { client } = requireAuthenticatedClient()
  await bootstrapCurrentClerkProfile()
  const { data, error } = await client.rpc('rotate_family_share_code', {
    p_circle_id: circleId,
  })
  if (error) throw error
  if (typeof data !== 'string' || !data) {
    throw new Error('The family share code could not be rotated.')
  }
  return data
}

export async function leaveFamily() {
  const { client } = requireAuthenticatedClient()
  await bootstrapCurrentClerkProfile()
  const { data, error } = await client.rpc('leave_current_family')
  if (error) throw error
  if (typeof data !== 'boolean') {
    throw new Error('The family membership could not be updated.')
  }
  return data
}
