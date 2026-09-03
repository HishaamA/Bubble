import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  function query() {
    const builder = {
      eq: vi.fn(),
      insert: vi.fn(),
      limit: vi.fn(),
      maybeSingle: vi.fn(),
      order: vi.fn(),
      select: vi.fn(),
      single: vi.fn(),
      update: vi.fn(),
    }
    builder.eq.mockReturnValue(builder)
    builder.insert.mockReturnValue(builder)
    builder.limit.mockReturnValue(builder)
    builder.order.mockReturnValue(builder)
    builder.select.mockReturnValue(builder)
    builder.update.mockReturnValue(builder)
    return builder
  }

  const membership = query()
  const preferences = query()
  const requests = query()
  const circles = query()
  const client = {
    from: vi.fn((table: string) => {
      if (table === 'circle_members') return membership
      if (table === 'profile_preferences') return preferences
      if (table === 'join_requests') return requests
      return circles
    }),
    rpc: vi.fn(),
  }
  return { circles, client, membership, preferences, requests }
})

vi.mock('../../lib/supabase', () => ({
  getClerkSupabaseIdentity: () => ({
    subject: 'user_clerk_alice',
    displayName: 'Alice Ahmed',
    email: 'alice@example.test',
  }),
  getSupabaseClient: () => mocks.client,
}))

import {
  bootstrapCurrentClerkProfile,
  createFamily,
  joinFamilyByCode,
  leaveFamily,
  markTutorialComplete,
  normalizeFamilyShareCode,
  readFamilyMembers,
  readFamilyMembership,
  readFamilyShareCode,
  readProfilePreferences,
  rotateFamilyShareCode,
  updateProfilePreferences,
} from './clerkPersistence'

const internalUserId = '10000000-0000-4000-8000-000000000001'
const circleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function bootstrapRow(onboardingCompleted = false) {
  return {
    user_id: internalUserId,
    subject: 'user_clerk_alice',
    display_name: 'Alice Ahmed',
    email: 'alice@example.test',
    onboarding_completed: onboardingCompleted,
    onboarding_completed_at: onboardingCompleted
      ? '2026-08-27T10:00:00.000Z'
      : null,
  }
}

function familyRow(role: 'owner' | 'member' = 'owner') {
  return {
    family_id: circleId,
    family_name: 'The Ahmed family',
    family_role: role,
    owner_id: internalUserId,
    member_count: 3,
    share_code: 'BUB-1111-2222-3333-4444-5555-6666',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.client.rpc.mockImplementation(async (name: string) => {
    if (name === 'bootstrap_current_user') {
      return { data: [bootstrapRow()], error: null }
    }
    if (name === 'complete_current_user_onboarding') {
      return { data: '2026-08-27T10:00:00.000Z', error: null }
    }
    if (name === 'get_current_family') {
      return { data: [familyRow()], error: null }
    }
    if (name === 'create_family_with_share_code') {
      return { data: [familyRow()], error: null }
    }
    if (name === 'join_family_by_share_code') {
      return { data: [familyRow('member')], error: null }
    }
    if (name === 'list_current_family_members') {
      return {
        data: [
          {
            family_id: circleId,
            user_id: internalUserId,
            display_name: 'Alice Ahmed',
            avatar_path: 'avatars/alice.jpg',
            family_role: 'owner',
            joined_at: '2026-09-03T10:00:00.000Z',
          },
        ],
        error: null,
      }
    }
    if (name === 'get_or_create_family_share_code') {
      return { data: 'BUB-1111-2222-3333-4444-5555-6666', error: null }
    }
    if (name === 'rotate_family_share_code') {
      return { data: 'BUB-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', error: null }
    }
    if (name === 'leave_current_family') {
      return { data: true, error: null }
    }
    if (name === 'request_circle_join') {
      return {
        data: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        error: null,
      }
    }
    return { data: null, error: null }
  })
  mocks.membership.maybeSingle.mockResolvedValue({ data: null, error: null })
  mocks.requests.maybeSingle.mockResolvedValue({ data: null, error: null })
  mocks.preferences.single.mockResolvedValue({
    data: {
      notifications_enabled: true,
      quiet_hours_start: '22:00:00',
      quiet_hours_end: '08:00:00',
    },
    error: null,
  })
  mocks.circles.single.mockResolvedValue({
    data: { id: circleId, name: 'The Ahmed family' },
    error: null,
  })
})

describe('Clerk-backed persistence service', () => {
  it('bootstraps from display metadata while PostgreSQL owns the subject', async () => {
    await expect(bootstrapCurrentClerkProfile()).resolves.toEqual({
      userId: internalUserId,
      subject: 'user_clerk_alice',
      displayName: 'Alice Ahmed',
      email: 'alice@example.test',
      onboardingCompleted: false,
      onboardingCompletedAt: null,
    })
    expect(mocks.client.rpc).toHaveBeenCalledWith('bootstrap_current_user', {
      p_display_name: 'Alice Ahmed',
      p_email: 'alice@example.test',
    })
    expect(mocks.client.rpc.mock.calls[0]?.[1]).not.toHaveProperty('subject')
  })

  it('persists tutorial completion through the authenticated RPC', async () => {
    await expect(markTutorialComplete()).resolves.toEqual({
      completed: true,
      completedAt: '2026-08-27T10:00:00.000Z',
    })
    expect(mocks.client.rpc).toHaveBeenCalledWith(
      'complete_current_user_onboarding',
    )
  })

  it('reads an approved family membership scoped to the internal identity', async () => {
    await expect(readFamilyMembership()).resolves.toEqual({
      kind: 'member',
      userId: internalUserId,
      circleId,
      circleName: 'The Ahmed family',
      role: 'owner',
      ownerId: internalUserId,
      memberCount: 3,
      shareCode: 'BUB-1111-2222-3333-4444-5555-6666',
    })
    expect(mocks.client.rpc).toHaveBeenCalledWith(
      'get_current_family',
    )
  })

  it('creates a family with a reusable code and joins it immediately', async () => {
    await expect(createFamily('  The Ahmed family  ')).resolves.toEqual({
      id: circleId,
      name: 'The Ahmed family',
      role: 'owner',
      ownerId: internalUserId,
      memberCount: 3,
      shareCode: 'BUB-1111-2222-3333-4444-5555-6666',
    })
    expect(mocks.client.rpc).toHaveBeenCalledWith(
      'create_family_with_share_code',
      { p_name: 'The Ahmed family' },
    )

    const code = 'bub-1111-2222-3333-4444-5555-6666'
    await expect(joinFamilyByCode(code)).resolves.toEqual({
      id: circleId,
      name: 'The Ahmed family',
      role: 'member',
      ownerId: internalUserId,
      memberCount: 3,
      shareCode: 'BUB-1111-2222-3333-4444-5555-6666',
    })
    expect(mocks.client.rpc).toHaveBeenCalledWith(
      'join_family_by_share_code',
      { p_share_code: code.toUpperCase() },
    )
  })

  it('keeps previously issued one-use invite codes compatible', async () => {
    const code = `ks1_${'a'.repeat(64)}`
    await expect(joinFamilyByCode(code)).resolves.toEqual({
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    })
    expect(mocks.client.rpc).toHaveBeenCalledWith('request_circle_join', {
      p_invite_code: code,
    })
  })

  it('rejects malformed family codes before making a backend request', async () => {
    await expect(joinFamilyByCode('not a family code')).rejects.toThrow(
      'invalid_family_code',
    )

    expect(mocks.client.rpc).not.toHaveBeenCalled()
  })

  it('loads the family roster and manages the owner share code', async () => {
    await expect(readFamilyMembers()).resolves.toEqual([
      {
        familyId: circleId,
        userId: internalUserId,
        displayName: 'Alice Ahmed',
        avatarPath: 'avatars/alice.jpg',
        role: 'owner',
        joinedAt: '2026-09-03T10:00:00.000Z',
      },
    ])
    await expect(readFamilyShareCode(circleId)).resolves.toBe(
      'BUB-1111-2222-3333-4444-5555-6666',
    )
    await expect(rotateFamilyShareCode(circleId)).resolves.toBe(
      'BUB-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
    )
    await expect(leaveFamily()).resolves.toBe(true)

    expect(mocks.client.rpc).toHaveBeenCalledWith(
      'get_or_create_family_share_code',
      { p_circle_id: circleId },
    )
    expect(mocks.client.rpc).toHaveBeenCalledWith(
      'rotate_family_share_code',
      { p_circle_id: circleId },
    )
  })

  it('normalizes readable family codes without weakening validation', () => {
    expect(
      normalizeFamilyShareCode(
        '  bub-1111-2222-3333-4444-5555-6666  ',
      ),
    ).toBe('BUB-1111-2222-3333-4444-5555-6666')
  })

  it('reads and updates private preferences for only the mapped user', async () => {
    await expect(readProfilePreferences()).resolves.toEqual({
      notificationsEnabled: true,
      quietHoursEnabled: true,
      quietHoursStart: '22:00:00',
      quietHoursEnd: '08:00:00',
    })
    expect(mocks.preferences.eq).toHaveBeenCalledWith(
      'user_id',
      internalUserId,
    )

    mocks.preferences.single.mockResolvedValueOnce({
      data: {
        notifications_enabled: false,
        quiet_hours_start: null,
        quiet_hours_end: null,
      },
      error: null,
    })
    await expect(
      updateProfilePreferences({
        notificationsEnabled: false,
        quietHoursEnabled: false,
      }),
    ).resolves.toEqual({
      notificationsEnabled: false,
      quietHoursEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
    })
    expect(mocks.preferences.update).toHaveBeenCalledWith({
      notifications_enabled: false,
      quiet_hours_start: null,
      quiet_hours_end: null,
    })
  })

  it('reads preferences once when an update contains no supported fields', async () => {
    await expect(updateProfilePreferences({})).resolves.toEqual({
      notificationsEnabled: true,
      quietHoursEnabled: true,
      quietHoursStart: '22:00:00',
      quietHoursEnd: '08:00:00',
    })

    expect(mocks.preferences.update).not.toHaveBeenCalled()
    expect(mocks.client.rpc).toHaveBeenCalledTimes(1)
    expect(mocks.client.rpc).toHaveBeenCalledWith('bootstrap_current_user', {
      p_display_name: 'Alice Ahmed',
      p_email: 'alice@example.test',
    })
  })
})
