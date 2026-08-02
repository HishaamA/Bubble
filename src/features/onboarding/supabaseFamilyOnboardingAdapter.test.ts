import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFamily: vi.fn(),
  joinFamilyByCode: vi.fn(),
  readFamilyMembership: vi.fn(),
}))

vi.mock('../../lib/supabase', () => ({
  getClerkSupabaseIdentity: () => ({ subject: 'user_clerk_alice' }),
  getSupabaseClient: () => ({}),
}))
vi.mock('../../services/persistence', () => mocks)

import { supabaseFamilyOnboardingAdapter } from './supabaseFamilyOnboardingAdapter'

const actor = {
  userId: 'user_clerk_alice',
  getToken: async () => 'clerk-token',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readFamilyMembership.mockResolvedValue({
    kind: 'member',
    userId: '10000000-0000-4000-8000-000000000001',
    circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    circleName: 'The Ahmed family',
    role: 'owner',
  })
})

describe('supabaseFamilyOnboardingAdapter', () => {
  it('maps the persistent membership to the onboarding contract', async () => {
    await expect(
      supabaseFamilyOnboardingAdapter.loadAccess(actor),
    ).resolves.toEqual({
      kind: 'member',
      membership: {
        familyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        familyName: 'The Ahmed family',
        role: 'owner',
      },
    })
  })

  it('creates and joins through database-backed workflows', async () => {
    await supabaseFamilyOnboardingAdapter.createFamily(
      actor,
      'The Ahmed family',
    )
    expect(mocks.createFamily).toHaveBeenCalledWith('The Ahmed family')

    mocks.readFamilyMembership.mockResolvedValue({
      kind: 'unjoined',
      userId: '10000000-0000-4000-8000-000000000001',
      pendingRequestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    })
    await expect(
      supabaseFamilyOnboardingAdapter.joinFamily(
        actor,
        `ks1_${'a'.repeat(64)}`,
      ),
    ).resolves.toEqual({ kind: 'pending', familyName: null })
    expect(mocks.joinFamilyByCode).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale actor before making a database request', async () => {
    await expect(
      supabaseFamilyOnboardingAdapter.loadAccess({
        ...actor,
        userId: 'user_someone_else',
      }),
    ).rejects.toThrow('no longer matches')
    expect(mocks.readFamilyMembership).not.toHaveBeenCalled()
  })
})
