import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClerkSupabaseIdentity } from '../../lib/supabase'
import { syncCurrentProfileAvatar } from './profileAvatarPersistence'

const session = vi.hoisted(() => ({ identity: vi.fn() }))
vi.mock('../../lib/supabase', () => ({ getClerkSupabaseIdentity: session.identity }))

const userId = '10000000-0000-4000-8000-000000000001'
const avatar = 'https://img.clerk.com/user-alice.jpg'
let identity: ClerkSupabaseIdentity

function clientFixture() {
  const query = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn() }
  query.update.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.select.mockReturnValue(query)
  query.single.mockResolvedValue({ data: { id: userId }, error: null })
  const from = vi.fn(() => query)
  return { client: { from } as unknown as SupabaseClient, from, query }
}

beforeEach(() => {
  identity = { subject: 'user_alice', imageUrl: avatar }
  session.identity.mockImplementation(() => identity)
})

describe('self profile avatar sharing', () => {
  it('updates only the bootstrapped internal user and coalesces repeated bootstrap calls', async () => {
    const { client, from, query } = clientFixture()
    await Promise.all([
      syncCurrentProfileAvatar(client, userId, identity),
      syncCurrentProfileAvatar(client, userId, identity),
    ])
    await syncCurrentProfileAvatar(client, userId, identity)
    expect(from).toHaveBeenCalledExactlyOnceWith('profiles')
    expect(query.update).toHaveBeenCalledExactlyOnceWith({ avatar_path: avatar })
    expect(query.eq).toHaveBeenCalledExactlyOnceWith('id', userId)
    expect(query.select).toHaveBeenCalledExactlyOnceWith('id')
  })

  it.each([
    undefined, '', 'file:///phone/profile.jpg', 'blob:private-photo',
    'http://images.example/avatar.jpg', 'https://user:secret@images.example/avatar.jpg',
    `https://images.example/${'a'.repeat(501)}`,
  ])('does not persist nonportable or unsafe avatar %s', async (imageUrl) => {
    const { client, from } = clientFixture()
    identity = { ...identity, imageUrl }
    await syncCurrentProfileAvatar(client, userId, identity)
    expect(from).not.toHaveBeenCalled()
  })

  it('clears a removed Clerk avatar without overwriting any other profile field', async () => {
    const { client, query } = clientFixture()
    identity = { ...identity, imageUrl: null }
    await syncCurrentProfileAvatar(client, userId, identity)
    expect(query.update).toHaveBeenCalledExactlyOnceWith({ avatar_path: null })
  })

  it('does not start an old account’s update after the identity switches', async () => {
    const { client, from } = clientFixture()
    const oldIdentity = identity
    identity = { subject: 'user_bob', imageUrl: 'https://img.clerk.com/bob.jpg' }
    await syncCurrentProfileAvatar(client, userId, oldIdentity)
    expect(from).not.toHaveBeenCalled()
  })

  it('keeps avatars optional and retries failed writes on the next bootstrap', async () => {
    const { client, query } = clientFixture()
    query.single.mockRejectedValueOnce(new Error('Offline'))
    await expect(syncCurrentProfileAvatar(client, userId, identity)).resolves.toBeUndefined()
    await syncCurrentProfileAvatar(client, userId, identity)
    expect(query.update).toHaveBeenCalledTimes(2)
  })

  it('does not cache a denied update as successful', async () => {
    const { client, query } = clientFixture()
    query.single.mockResolvedValueOnce({ data: null, error: { message: 'Not authorized' } })
    await syncCurrentProfileAvatar(client, userId, identity)
    await syncCurrentProfileAvatar(client, userId, identity)
    expect(query.update).toHaveBeenCalledTimes(2)
  })

  it('serializes avatar changes so an older response cannot win over the new image', async () => {
    const { client, query } = clientFixture()
    let finishOld!: (value: unknown) => void
    query.single.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve }))
    const first = syncCurrentProfileAvatar(client, userId, identity)
    await Promise.resolve()
    const replacement = 'https://img.clerk.com/new-alice.jpg'
    identity = { ...identity, imageUrl: replacement }
    const second = syncCurrentProfileAvatar(client, userId, identity)
    await Promise.resolve()
    expect(query.update).toHaveBeenCalledTimes(1)
    finishOld({ data: { id: userId }, error: null })
    await Promise.all([first, second])
    expect(query.update.mock.calls).toEqual([
      [{ avatar_path: avatar }], [{ avatar_path: replacement }],
    ])
  })
})
