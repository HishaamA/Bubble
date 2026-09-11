import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const channel = { on: vi.fn(), subscribe: vi.fn() }
  channel.on.mockReturnValue(channel)
  channel.subscribe.mockReturnValue(channel)
  const client = {
    rpc: vi.fn(),
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  }
  return {
    channel,
    client,
    getSupabaseClient: vi.fn(() => client),
    getClerkSupabaseIdentity: vi.fn(),
    bootstrapCurrentClerkProfile: vi.fn(),
  }
})

vi.mock('../../lib/supabase', () => ({
  getSupabaseClient: mocks.getSupabaseClient,
  getClerkSupabaseIdentity: mocks.getClerkSupabaseIdentity,
}))
vi.mock('../../services/persistence', () => ({
  bootstrapCurrentClerkProfile: mocks.bootstrapCurrentClerkProfile,
}))

import {
  fetchPhotoReactions,
  setPhotoReaction,
  subscribeToPhotoReactions,
} from './photoReactionService'

const photoId = '71000000-0000-4000-8000-000000000003'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSupabaseClient.mockReturnValue(mocks.client)
  mocks.getClerkSupabaseIdentity.mockReturnValue({ subject: 'user_alice' })
  mocks.bootstrapCurrentClerkProfile.mockResolvedValue({ userId: 'server-user-alice' })
  mocks.client.rpc.mockResolvedValue({ data: [], error: null })
})

describe('capsule photo reactions', () => {
  it('loads only valid nonzero counts and the server-derived current member selection', async () => {
    mocks.client.rpc.mockResolvedValue({
      error: null,
      data: [
        { emoji: '👏', reaction_count: 2, reacted_by_me: false },
        { emoji: '❤️', reaction_count: 3, reacted_by_me: true },
        { emoji: '🥰', reaction_count: -1, reacted_by_me: false },
        { emoji: '😂', reaction_count: 1.5, reacted_by_me: false },
        { emoji: '😮', reaction_count: 1, reacted_by_me: 'false' },
        { emoji: '🔥', reaction_count: 1, reacted_by_me: false },
        { emoji: null, reaction_count: 1, reacted_by_me: false },
        null,
      ],
    })

    await expect(fetchPhotoReactions(photoId)).resolves.toEqual([
      { emoji: '❤️', count: 3, reactedByMe: true },
      { emoji: '👏', count: 2, reactedByMe: false },
    ])
    expect(mocks.bootstrapCurrentClerkProfile).toHaveBeenCalledOnce()
    expect(mocks.client.rpc).toHaveBeenCalledWith('list_capsule_photo_reactions', { p_item_id: photoId })
  })

  it('sets, replaces, and clears a selection without supplying an author identity', async () => {
    mocks.client.rpc.mockResolvedValueOnce({
      data: [{ emoji: '❤️', reaction_count: 2, reacted_by_me: true }], error: null,
    }).mockResolvedValueOnce({
      data: [{ emoji: '👏', reaction_count: 1, reacted_by_me: true }], error: null,
    }).mockResolvedValueOnce({ data: [], error: null })

    await expect(setPhotoReaction(photoId, '❤️')).resolves.toEqual([
      { emoji: '❤️', count: 2, reactedByMe: true },
    ])
    await expect(setPhotoReaction(photoId, '👏')).resolves.toEqual([
      { emoji: '👏', count: 1, reactedByMe: true },
    ])
    await expect(setPhotoReaction(photoId, null)).resolves.toEqual([])
    expect(mocks.client.rpc.mock.calls).toEqual([
      ['set_capsule_photo_reaction', { p_item_id: photoId, p_emoji: '❤️' }],
      ['set_capsule_photo_reaction', { p_item_id: photoId, p_emoji: '👏' }],
      ['set_capsule_photo_reaction', { p_item_id: photoId, p_emoji: null }],
    ])
  })

  it('rejects invalid targets and emoji before contacting the backend', async () => {
    await expect(fetchPhotoReactions('local-photo')).rejects.toThrow('shared capsule photo')
    await expect(setPhotoReaction(photoId, '🔥')).rejects.toThrow('available photo reactions')
    expect(mocks.bootstrapCurrentClerkProfile).not.toHaveBeenCalled()
    expect(mocks.client.rpc).not.toHaveBeenCalled()
  })

  it('requires an authenticated family connection and preserves access-denied failures', async () => {
    mocks.getClerkSupabaseIdentity.mockReturnValue(null)
    await expect(fetchPhotoReactions(photoId)).rejects.toThrow('Sign in')
    await expect(setPhotoReaction(photoId, '❤️')).rejects.toThrow('Sign in')
    expect(mocks.client.rpc).not.toHaveBeenCalled()

    mocks.getClerkSupabaseIdentity.mockReturnValue({ subject: 'user_removed' })
    const error = { code: '42501', message: 'capsule_photo_not_available' }
    mocks.client.rpc.mockResolvedValue({ data: null, error })
    await expect(fetchPhotoReactions(photoId)).rejects.toEqual(error)
    await expect(setPhotoReaction(photoId, '❤️')).rejects.toEqual(error)
  })

  it('subscribes to the exact photo and removes the channel on cleanup', () => {
    const changed = vi.fn()
    const cleanup = subscribeToPhotoReactions(photoId, changed)
    expect(mocks.channel.on).toHaveBeenCalledWith('postgres_changes', {
      event: '*', schema: 'public', table: 'family_capsule_photo_reactions',
      filter: `item_id=eq.${photoId}`,
    }, changed)
    cleanup()
    expect(mocks.client.removeChannel).toHaveBeenCalledWith(mocks.channel)
  })

  it('does not subscribe local photos or signed-out users to shared reactions', () => {
    subscribeToPhotoReactions('local-photo', vi.fn())()
    mocks.getClerkSupabaseIdentity.mockReturnValue(null)
    subscribeToPhotoReactions(photoId, vi.fn())()
    expect(mocks.client.channel).not.toHaveBeenCalled()
  })
})
