import {
  getClerkSupabaseIdentity,
  getSupabaseClient,
} from '../../lib/supabase'

// This module is the only UI-facing boundary for authenticated profile and
// family RPCs. Every server payload is narrowed before it leaves the service.
type UnknownRecord = Record<string, unknown>

const FAMILY_SHARE_CODE_PATTERN = /^BUB-[0-9A-F]{4}(-[0-9A-F]{4}){5}$/
const LEGACY_FAMILY_INVITE_PATTERN = /^ks1_[0-9a-f]{64}$/
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

/** Narrows untrusted Supabase JSON to an object before field access. */
function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' ? (value as UnknownRecord) : null
}

/** RPCs may return one row directly or wrap it in a one-element array. */
function firstRecord(value: unknown) {
  return asRecord(Array.isArray(value) ? value[0] : value)
}

/** Requires a present string in a server response and preserves its value. */
function requireStringField(record: UnknownRecord, key: string) {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Supabase returned an invalid ${key} value.`)
  }
  return value
}

/** Converts absent or empty optional server strings to null. */
function readOptionalStringField(record: UnknownRecord, key: string) {
  const value = record[key]
  return typeof value === 'string' && value ? value : null
}

/** Requires a count-like server field suitable for UI display. */
function requireNonNegativeIntegerField(record: UnknownRecord, key: string) {
  const value = record[key]
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`Supabase returned an invalid ${key} value.`)
  }
  return value
}

/** Narrows the database family role to the two client-supported values. */
function readFamilyRole(record: UnknownRecord): 'owner' | 'member' {
  const role = record.family_role
  if (role !== 'owner' && role !== 'member') {
    throw new Error('Supabase returned an invalid family role.')
  }
  return role
}

/** Maps a validated family RPC row to the shared client shape. */
function parseFamily(record: UnknownRecord) {
  return {
    id: requireStringField(record, 'family_id'),
    name: requireStringField(record, 'family_name'),
    role: readFamilyRole(record),
    ownerId: requireStringField(record, 'owner_id'),
    memberCount: requireNonNegativeIntegerField(record, 'member_count'),
    shareCode: requireStringField(record, 'share_code'),
  }
}

/** Converts a pasted family code to the canonical server format. */
export function normalizeFamilyShareCode(value: string): string {
  return value.trim().toUpperCase()
}

/** Converts nullable quiet-hour fields to the UI's enabled-state model. */
function parseProfilePreferences(
  record: UnknownRecord,
): ProfilePreferences {
  const quietHoursStart = readOptionalStringField(record, 'quiet_hours_start')
  const quietHoursEnd = readOptionalStringField(record, 'quiet_hours_end')
  return {
    notificationsEnabled: record.notifications_enabled === true,
    quietHoursEnabled: Boolean(quietHoursStart && quietHoursEnd),
    quietHoursStart,
    quietHoursEnd,
  }
}

/** Requires both configured storage and a verified Clerk identity. */
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
  const subject = requireStringField(record, 'subject')
  if (subject !== identity.subject) {
    throw new Error('The authenticated profile did not match the Clerk session.')
  }

  return {
    userId: requireStringField(record, 'user_id'),
    subject,
    displayName: requireStringField(record, 'display_name'),
    email: readOptionalStringField(record, 'email'),
    onboardingCompleted: record.onboarding_completed === true,
    onboardingCompletedAt: readOptionalStringField(
      record,
      'onboarding_completed_at',
    ),
  }
}

/** Reads the current account's durable onboarding completion state. */
export async function readOnboardingState(): Promise<OnboardingState> {
  const profile = await bootstrapCurrentClerkProfile()
  return {
    completed: profile.onboardingCompleted,
    completedAt: profile.onboardingCompletedAt,
  }
}

/** Marks onboarding complete using the authenticated database identity. */
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

/** Loads notification preferences scoped to the current account. */
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
  return parseProfilePreferences(preferences)
}

/** Applies the supplied preference fields without overwriting omitted fields. */
export async function updateProfilePreferences(
  patch: ProfilePreferencesPatch,
): Promise<ProfilePreferences> {
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

  const { client } = requireAuthenticatedClient()
  const profile = await bootstrapCurrentClerkProfile()

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
  return parseProfilePreferences(preferences)
}

/** Returns either the approved family membership or its pending join request. */
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
      pendingRequestId: pending ? requireStringField(pending, 'id') : null,
    }
  }

  const family = parseFamily(familyRecord)

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

/** Creates a family and returns the reusable owner-managed share code. */
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
  const family = parseFamily(record)
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

/** Joins with a current reusable code or submits a legacy invite request. */
export async function joinFamilyByCode(
  inviteCode: string,
): Promise<JoinedFamily | { requestId: string }> {
  const normalizedCode = normalizeFamilyShareCode(inviteCode)
  const legacyCode = inviteCode.trim().toLowerCase()
  const isCurrentCode = FAMILY_SHARE_CODE_PATTERN.test(normalizedCode)
  const isLegacyCode = LEGACY_FAMILY_INVITE_PATTERN.test(legacyCode)
  if (!isCurrentCode && !isLegacyCode) {
    throw new Error('invalid_family_code')
  }

  const { client } = requireAuthenticatedClient()
  await bootstrapCurrentClerkProfile()

  if (isCurrentCode) {
    const { data, error } = await client.rpc(
      'join_family_by_share_code',
      { p_share_code: normalizedCode },
    )
    if (error) throw error
    const record = firstRecord(data)
    if (!record) throw new Error('The family could not be joined.')
    const family = parseFamily(record)
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
  const { data, error } = await client.rpc('request_circle_join', {
    p_invite_code: legacyCode,
  })
  if (error) throw error
  if (typeof data !== 'string') {
    throw new Error('The family join request could not be saved.')
  }
  return { requestId: data }
}

/** Lists approved members of the current account's family. */
export async function readFamilyMembers(): Promise<FamilyMember[]> {
  const { client } = requireAuthenticatedClient()
  await bootstrapCurrentClerkProfile()
  const { data, error } = await client.rpc(
    'list_current_family_members',
  )
  if (error) throw error

  if (!Array.isArray(data)) return []
  return data.map((memberRow) => {
    const member = asRecord(memberRow)
    if (!member) throw new Error('A family member could not be loaded.')
    const role = readFamilyRole(member)
    return {
      familyId: requireStringField(member, 'family_id'),
      userId: requireStringField(member, 'user_id'),
      displayName: requireStringField(member, 'display_name'),
      avatarPath: readOptionalStringField(member, 'avatar_path'),
      role,
      joinedAt: requireStringField(member, 'joined_at'),
    }
  })
}

/** Returns the current family share code, creating one server-side if needed. */
export async function readFamilyShareCode(circleId: string): Promise<string> {
  if (!UUID_PATTERN.test(circleId)) {
    throw new TypeError('Choose a valid family before loading its share code.')
  }
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

/** Invalidates the previous family code and returns its replacement. */
export async function rotateFamilyShareCode(circleId: string): Promise<string> {
  if (!UUID_PATTERN.test(circleId)) {
    throw new TypeError('Choose a valid family before rotating its share code.')
  }
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

/** Removes the current account from its family when server policy permits it. */
export async function leaveFamily(): Promise<boolean> {
  const { client } = requireAuthenticatedClient()
  await bootstrapCurrentClerkProfile()
  const { data, error } = await client.rpc('leave_current_family')
  if (error) throw error
  if (typeof data !== 'boolean') {
    throw new Error('The family membership could not be updated.')
  }
  return data
}
