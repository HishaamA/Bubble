import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  identity: vi.fn(), getClient: vi.fn(), bootstrap: vi.fn(), membership: vi.fn(),
  members: vi.fn(), create: vi.fn(), join: vi.fn(), rotate: vi.fn(),
  query: { select: vi.fn(), eq: vi.fn(), order: vi.fn() },
  client: { from: vi.fn(), rpc: vi.fn() },
}))
vi.mock('../../../lib/supabase', () => ({
  getClerkSupabaseIdentity: mocks.identity,
  getSupabaseClient: mocks.getClient,
  subscribeToSupabaseAuthChanges: vi.fn(() => () => undefined),
}))
vi.mock('../../../services/persistence', () => ({
  bootstrapCurrentClerkProfile: mocks.bootstrap,
  readFamilyMembership: mocks.membership,
  readFamilyMembers: mocks.members,
  createFamily: mocks.create,
  joinFamilyByCode: mocks.join,
  rotateFamilyShareCode: mocks.rotate,
}))
import { familySyncAdapter, toFamilySyncErrorMessage } from './familySyncAdapter'

describe('toFamilySyncErrorMessage', () => {
  it('turns invite failures into useful messages without echoing credentials', () => {
    expect(toFamilySyncErrorMessage(new Error('invalid_invite_code'))).toBe(
      'That family code is not valid.',
    )
    expect(toFamilySyncErrorMessage(new Error('invite_not_available'))).toBe(
      'That invite has expired, was revoked, or has already been used.',
    )
  })

  it('explains invalid persistent family codes without exposing them', () => {
    expect(toFamilySyncErrorMessage(new Error('family_code_not_found'))).toBe(
      'That family code is not valid.',
    )
    expect(toFamilySyncErrorMessage(new Error('invalid_family_code'))).toBe(
      'That family code is not valid.',
    )
  })

  it('explains owner-only membership decisions', () => {
    expect(toFamilySyncErrorMessage(new Error('circle_owner_required'))).toBe(
      'Only the family circle owner can do that.',
    )
  })

  it('does not expose unknown backend details in the settings page', () => {
    const backendMessage =
      'SQL failed for service_role credential abc123 in private_table'

    expect(toFamilySyncErrorMessage(new Error(backendMessage))).toBe(
      'Family Sync could not complete that request.',
    )
    expect(toFamilySyncErrorMessage(new Error(backendMessage))).not.toContain(
      'abc123',
    )
  })
})

describe('familySyncAdapter snapshots', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.getClient.mockReturnValue(mocks.client)
    mocks.identity.mockReturnValue({ subject: 'clerk-alice', email: 'alice@example.test' })
    mocks.bootstrap.mockResolvedValue({ userId: 'alice', subject: 'clerk-alice', displayName: 'Alice', email: 'alice@example.test' })
    mocks.membership.mockResolvedValue({
      kind: 'member', userId: 'alice', circleId: 'family', circleName: 'Our family',
      role: 'owner', memberCount: 20, shareCode: 'BUB-1111-2222-3333-4444-5555-6666',
    })
    mocks.members.mockResolvedValue([
      { familyId: 'family', userId: 'alice', displayName: 'Alice', role: 'owner', avatarPath: 'avatars/private.jpg' },
      { familyId: 'family', userId: 'bob', displayName: 'Bob', role: 'member', avatarPath: 'https://images.example/bob.jpg' },
    ])
    mocks.client.from.mockReturnValue(mocks.query)
    mocks.query.select.mockReturnValue(mocks.query)
    mocks.query.eq.mockReturnValue(mocks.query)
    mocks.query.order.mockResolvedValue({ data: [], error: null })
  })

  it('shows actual approved members, roles and You without exposing other member emails', async () => {
    const snapshot = await familySyncAdapter.loadSnapshot()
    expect(snapshot.kind).toBe('connected')
    if (snapshot.kind !== 'connected') throw new Error('Expected connected family')
    expect(mocks.members).toHaveBeenCalledWith('family')
    expect(snapshot.circle.memberCount).toBe(2)
    expect(snapshot.members).toEqual([
      { id: 'alice', displayName: 'Alice', role: 'owner', avatarUrl: null, isCurrentUser: true },
      { id: 'bob', displayName: 'Bob', role: 'member', avatarUrl: 'https://images.example/bob.jpg', isCurrentUser: false },
    ])
    expect(snapshot.members.some((member) => 'email' in member)).toBe(false)
  })

  it('does not query owner approval requests for a regular member', async () => {
    mocks.membership.mockResolvedValue({
      kind: 'member', userId: 'alice', circleId: 'family', circleName: 'Our family',
      role: 'member', memberCount: 2, shareCode: 'BUB-1111-2222-3333-4444-5555-6666',
    })
    mocks.members.mockResolvedValue([
      { familyId: 'family', userId: 'bob', displayName: 'Bob', role: 'owner', avatarPath: null },
      { familyId: 'family', userId: 'alice', displayName: 'Alice', role: 'member', avatarPath: null },
    ])
    const snapshot = await familySyncAdapter.loadSnapshot()
    expect(snapshot.kind).toBe('connected')
    expect(mocks.client.from).not.toHaveBeenCalled()
  })

  it('rejects another family roster rather than combining it with the old code', async () => {
    mocks.members.mockResolvedValue([
      { familyId: 'other-family', userId: 'alice', displayName: 'Alice', role: 'owner', avatarPath: null },
    ])
    await expect(familySyncAdapter.loadSnapshot()).rejects.toThrow('family_access_changed')
  })

  it('fails closed when this account has left the roster while the snapshot was loading', async () => {
    mocks.members.mockResolvedValue([
      { familyId: 'family', userId: 'bob', displayName: 'Bob', role: 'member', avatarPath: null },
    ])
    await expect(familySyncAdapter.loadSnapshot()).rejects.toThrow('family_access_changed')
  })

  it('rejects a late roster result after the signed-in account changes', async () => {
    mocks.members.mockImplementation(async () => {
      mocks.identity.mockReturnValue({ subject: 'clerk-bob' })
      return []
    })
    await expect(familySyncAdapter.loadSnapshot()).rejects.toThrow('account_changed')
  })

  it('rejects mixed owner/member permissions when a role changes during loading', async () => {
    mocks.members.mockResolvedValue([
      { familyId: 'family', userId: 'alice', displayName: 'Alice', role: 'member', avatarPath: null },
    ])
    await expect(familySyncAdapter.loadSnapshot()).rejects.toThrow('family_access_changed')
  })

  it('stops loading before membership queries when the account changes during bootstrap', async () => {
    mocks.bootstrap.mockImplementation(async () => {
      mocks.identity.mockReturnValue({ subject: 'clerk-bob' })
      return { userId: 'alice', subject: 'clerk-alice', displayName: 'Alice' }
    })
    await expect(familySyncAdapter.loadSnapshot()).rejects.toThrow('account_changed')
    expect(mocks.membership).not.toHaveBeenCalled()
  })

  it('does not render unsafe avatar sources from profile metadata', async () => {
    mocks.members.mockResolvedValue([
      { familyId: 'family', userId: 'alice', displayName: 'Alice', role: 'owner', avatarPath: 'javascript:alert(1)' },
      { familyId: 'family', userId: 'bob', displayName: 'Bob', role: 'member', avatarPath: 'https://password:secret@images.example/bob.jpg' },
    ])
    const snapshot = await familySyncAdapter.loadSnapshot()
    if (snapshot.kind !== 'connected') throw new Error('Expected connected family')
    expect(snapshot.members.map((member) => member.avatarUrl)).toEqual([null, null])
  })

  it('does not silently replace a missing roster with guessed people', async () => {
    mocks.members.mockRejectedValue(new Error('network unavailable'))
    await expect(familySyncAdapter.loadSnapshot()).rejects.toThrow('network unavailable')
  })

  it('forwards create/join/rotate through guarded persistence and preserves failures', async () => {
    mocks.rotate.mockResolvedValueOnce('replacement').mockRejectedValueOnce(new Error('circle_owner_required'))
    await familySyncAdapter.createCircle('Our family')
    await familySyncAdapter.requestCircleJoin('join-code')
    await expect(familySyncAdapter.rotateFamilyCode('family')).resolves.toBe('replacement')
    await expect(familySyncAdapter.rotateFamilyCode('family')).rejects.toThrow('circle_owner_required')
    expect(mocks.create).toHaveBeenCalledWith('Our family')
    expect(mocks.join).toHaveBeenCalledWith('join-code')
    expect(mocks.rotate).toHaveBeenCalledWith('family')
  })
})
