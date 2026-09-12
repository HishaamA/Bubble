import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  context: vi.fn(), isCurrent: vi.fn(), rpc: vi.fn(), remove: vi.fn(), bucket: vi.fn(),
  from: vi.fn(), select: vi.fn(), eq: vi.fn(), order: vi.fn(), range: vi.fn(),
  channel: vi.fn(), on: vi.fn(), subscribe: vi.fn(), removeChannel: vi.fn(),
}))
vi.mock('./capsuleService', () => ({ getCapsuleFamilyContext: mocks.context }))
import {
  deleteFamilyCapsule, deleteFamilyCapsulePhoto, fetchFamilyCapsuleDeletions,
  subscribeToFamilyCapsuleDeletions,
} from './capsuleDeletionService'

const circleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const capsuleId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const photoId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const otherId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const scope = `user_test:${circleId}`
const query = { select: mocks.select, eq: mocks.eq, order: mocks.order, range: mocks.range }
const channel = { on: mocks.on, subscribe: mocks.subscribe }
const client = {
  rpc: mocks.rpc, from: mocks.from, storage: { from: mocks.bucket },
  channel: mocks.channel, removeChannel: mocks.removeChannel,
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.context.mockResolvedValue({ client, circleId, userId, isCurrent: mocks.isCurrent })
  mocks.isCurrent.mockReturnValue(true)
  mocks.rpc.mockResolvedValue({ data: true, error: null })
  mocks.bucket.mockReturnValue({ remove: mocks.remove })
  mocks.remove.mockResolvedValue({ error: null })
  mocks.from.mockReturnValue(query)
  for (const method of [mocks.select, mocks.eq, mocks.order]) method.mockReturnValue(query)
  mocks.range.mockResolvedValue({ data: [], error: null })
  mocks.channel.mockReturnValue(channel)
  mocks.on.mockReturnValue(channel)
  mocks.subscribe.mockReturnValue(channel)
})

describe('Capsule deletion boundary', () => {
  it('deletes the uploader’s exact photo before cleaning only their own canonical media paths', async () => {
    await deleteFamilyCapsulePhoto(capsuleId, photoId, scope)
    expect(mocks.context).toHaveBeenCalledWith(scope)
    expect(mocks.rpc).toHaveBeenCalledWith('delete_family_capsule_photo', {
      p_circle_id: circleId, p_capsule_id: capsuleId, p_photo_id: photoId,
    })
    expect(mocks.remove).toHaveBeenCalledWith([
      `${circleId}/capsule-images/${userId}/${photoId}.jpg`,
      `${circleId}/capsule-thumbnails/${userId}/${photoId}.jpg`,
    ])
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]!)
  })

  it('asks the server for creator-only Capsule removal without attempting another uploader’s media cleanup', async () => {
    await deleteFamilyCapsule(capsuleId, scope)
    expect(mocks.rpc).toHaveBeenCalledWith('delete_family_capsule', { p_circle_id: circleId, p_capsule_id: capsuleId })
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it.each(['../another/photo', '', 'https://example.test/photo'])('rejects untrusted IDs before resolving family context: %s', async (invalid) => {
    await expect(deleteFamilyCapsulePhoto(capsuleId, invalid, scope)).rejects.toThrow('valid Capsule photo')
    await expect(deleteFamilyCapsule(invalid, scope)).rejects.toThrow('valid Capsule')
    expect(mocks.context).not.toHaveBeenCalled()
  })

  it('does not contact family APIs for a known local-only namespace', async () => {
    await deleteFamilyCapsule(capsuleId, 'user_test:no-family')
    await deleteFamilyCapsulePhoto(capsuleId, photoId, 'user_test:no-family')
    expect(mocks.context).not.toHaveBeenCalled()
  })

  it('rejects stale or unavailable account context before a write', async () => {
    mocks.context.mockResolvedValueOnce(null)
    await expect(deleteFamilyCapsule(capsuleId, scope)).rejects.toThrow('Reconnect')
    mocks.isCurrent.mockReturnValue(false)
    await expect(deleteFamilyCapsulePhoto(capsuleId, photoId, scope)).rejects.toThrow('Reconnect')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it.each([{ data: false, error: null }, { data: null, error: { code: '42501' } }])('preserves media on server denial: %j', async (response) => {
    mocks.rpc.mockResolvedValue(response)
    await expect(deleteFamilyCapsulePhoto(capsuleId, photoId, scope)).rejects.toThrow('could not be deleted')
    await expect(deleteFamilyCapsule(capsuleId, scope)).rejects.toThrow('Only its creator')
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('does not fail authoritative deletion for interrupted media cleanup or mutate a new session', async () => {
    mocks.remove.mockRejectedValue(new Error('offline'))
    await expect(deleteFamilyCapsulePhoto(capsuleId, photoId, scope)).resolves.toBeUndefined()
    mocks.remove.mockClear()
    mocks.isCurrent.mockReturnValueOnce(true).mockReturnValue(false)
    await deleteFamilyCapsulePhoto(capsuleId, photoId, scope)
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('reads all pages of structured author-scoped markers, including the offline weekly key', async () => {
    mocks.range
      .mockResolvedValueOnce({ data: Array.from({ length: 500 }, () => ({ capsule_id: capsuleId, creator_id: userId, week_start: '2026-09-07', was_published: false })), error: null })
      .mockResolvedValueOnce({ data: [{ capsule_id: capsuleId, creator_id: otherId, was_published: true }], error: null })
      .mockResolvedValueOnce({ data: [
        { capsule_id: capsuleId, photo_id: photoId, uploader_id: userId, was_published: false },
        { capsule_id: capsuleId, photo_id: photoId, uploader_id: otherId, was_published: true },
        { capsule_id: capsuleId, photo_id: 'invalid', uploader_id: userId },
      ], error: null })
    await expect(fetchFamilyCapsuleDeletions(scope)).resolves.toEqual({
      capsules: [
        { capsuleId, creatorId: userId, ownedByCurrentUser: true, weekStart: '2026-09-07', wasPublished: false },
        { capsuleId, creatorId: otherId, ownedByCurrentUser: false, wasPublished: true },
      ],
      photos: [
        { capsuleId, photoId, uploaderId: userId, ownedByCurrentUser: true, wasPublished: false },
        { capsuleId, photoId, uploaderId: otherId, ownedByCurrentUser: false, wasPublished: true },
      ],
    })
    expect(mocks.range.mock.calls).toEqual([[0, 499], [500, 999], [0, 499]])
    expect(mocks.order).toHaveBeenCalledWith('uploader_id')
    expect(mocks.eq).toHaveBeenCalledWith('circle_id', circleId)
    expect(mocks.select.mock.calls).toEqual([
      ['capsule_id,creator_id,week_start,was_published'],
      ['capsule_id,creator_id,week_start,was_published'],
      ['capsule_id,photo_id,uploader_id,was_published'],
    ])
  })

  it.each([undefined, null, 'true', 1])('does not widen cancellation scope from a missing or malformed publication flag: %s', async (wasPublished) => {
    mocks.range
      .mockResolvedValueOnce({ data: [{ capsule_id: capsuleId, creator_id: userId, was_published: wasPublished }], error: null })
      .mockResolvedValueOnce({ data: [{ capsule_id: capsuleId, photo_id: photoId, uploader_id: userId, was_published: wasPublished }], error: null })
    await expect(fetchFamilyCapsuleDeletions(scope)).resolves.toEqual({
      capsules: [{ capsuleId, creatorId: userId, ownedByCurrentUser: true, wasPublished: false }],
      photos: [{ capsuleId, photoId, uploaderId: userId, ownedByCurrentUser: true, wasPublished: false }],
    })
  })

  it('distinguishes unavailable metadata and expired sessions from an empty successful read', async () => {
    mocks.context.mockResolvedValueOnce(null)
    await expect(fetchFamilyCapsuleDeletions(scope)).resolves.toBeNull()
    mocks.range.mockResolvedValueOnce({ data: null, error: new Error('offline') })
    await expect(fetchFamilyCapsuleDeletions(scope)).rejects.toThrow('offline')
    mocks.isCurrent.mockReturnValueOnce(true).mockReturnValue(false)
    await expect(fetchFamilyCapsuleDeletions(scope)).resolves.toBeNull()
  })

  it('subscribes to both deletion feeds and ignores callbacks after an account switch', async () => {
    const changed = vi.fn()
    const stop = await subscribeToFamilyCapsuleDeletions(changed, scope)
    expect(mocks.on).toHaveBeenCalledTimes(2)
    const callback = mocks.on.mock.calls[0]![2] as () => void
    callback()
    mocks.isCurrent.mockReturnValue(false)
    callback()
    expect(changed).toHaveBeenCalledOnce()
    stop()
    expect(mocks.removeChannel).toHaveBeenCalledWith(channel)
  })
})
