import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localFamilyOnboardingAdapter } from './localFamilyOnboardingAdapter'

const actor = (userId: string) => ({
  userId,
  getToken: vi.fn(async () => `${userId}-token`),
})

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('localFamilyOnboardingAdapter', () => {
  it('keeps the family code and member count available to every member', async () => {
    const owner = actor('owner-1')
    const member = actor('member-1')
    const created = await localFamilyOnboardingAdapter.createFamily(
      owner,
      'Ahmed family',
    )
    expect(created.kind).toBe('member')
    if (created.kind !== 'member') throw new Error('expected member snapshot')

    const joined = await localFamilyOnboardingAdapter.joinFamily(
      member,
      created.membership.shareCode ?? '',
    )

    expect(joined).toEqual({
      kind: 'member',
      membership: expect.objectContaining({
        role: 'member',
        ownerId: 'owner-1',
        memberCount: 2,
        shareCode: created.membership.shareCode,
      }),
    })
    await expect(localFamilyOnboardingAdapter.loadAccess(owner)).resolves.toEqual({
      kind: 'member',
      membership: expect.objectContaining({
        role: 'owner',
        memberCount: 2,
        shareCode: created.membership.shareCode,
      }),
    })
  })

  it('uses the random fallback when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const createdFamily = await localFamilyOnboardingAdapter.createFamily(
      actor('owner-1'),
      'Ahmed family',
    )

    expect(createdFamily).toEqual({
      kind: 'member',
      membership: expect.objectContaining({
        familyId: 'dev-family-8000800080008000',
        shareCode: 'BUB-8000-8000-8000-8000-8000-8000',
      }),
    })
  })
})
