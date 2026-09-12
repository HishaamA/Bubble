import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  context: vi.fn(), rpc: vi.fn(), remove: vi.fn(), range: vi.fn(),
  on: vi.fn(), subscribe: vi.fn(), removeChannel: vi.fn(),
  select: vi.fn(), eq: vi.fn(), order: vi.fn(), from: vi.fn(),
  bucket: vi.fn(), channel: vi.fn(), isCurrent: vi.fn(),
}))
vi.mock('./journalPhotoService', () => ({ getJournalFamilyContext: mocks.context }))
import {
  deleteFamilyJournalPhoto,
  fetchDeletedJournalPhotos,
  subscribeToJournalPhotoDeletions,
} from './journalPhotoDeletionService'

const photoId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const circleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
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
  mocks.range.mockResolvedValue({ data: [{ photo_id: photoId, uploader_id: userId }], error: null })
  mocks.channel.mockReturnValue(channel)
  mocks.on.mockReturnValue(channel)
  mocks.subscribe.mockReturnValue(channel)
})

describe('Journal photo deletion boundary', () => {
  it('asks the authenticated server to delete before cleaning only canonical self-owned media', async () => {
    await deleteFamilyJournalPhoto(photoId, scope)
    expect(mocks.context).toHaveBeenCalledWith(scope)
    expect(mocks.rpc).toHaveBeenCalledWith('delete_family_journal_photo', {
      p_circle_id: circleId, p_photo_id: photoId,
    })
    expect(mocks.bucket).toHaveBeenCalledWith('family-media')
    expect(mocks.remove).toHaveBeenCalledWith([
      `${circleId}/journal-images/${userId}/${photoId}.jpg`,
      `${circleId}/journal-thumbnails/${userId}/${photoId}.jpg`,
    ])
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]!)
  })

  it.each(['../another-person/photo', 'https://private.test/photo.jpg', ''])('rejects invalid IDs: %s', async (id) => {
    await expect(deleteFamilyJournalPhoto(id, scope)).rejects.toThrow('valid Journal photo')
    expect(mocks.context).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('allows local-only store removal without contacting another family', async () => {
    await expect(deleteFamilyJournalPhoto(photoId, 'user_test:no-family')).resolves.toBeUndefined()
    expect(mocks.context).not.toHaveBeenCalled()
  })

  it('rejects missing or stale identities before mutation', async () => {
    mocks.context.mockResolvedValueOnce(null)
    await expect(deleteFamilyJournalPhoto(photoId, scope)).rejects.toThrow('Reconnect')
    mocks.isCurrent.mockReturnValue(false)
    await expect(deleteFamilyJournalPhoto(photoId, scope)).rejects.toThrow('Reconnect')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it.each([
    { data: null, error: { code: '42501' } },
    { data: false, error: null },
    { data: null, error: { code: 'PGRST202' } },
  ])('never removes media if the server denies or lacks the deletion RPC', async (response) => {
    mocks.rpc.mockResolvedValue(response)
    await expect(deleteFamilyJournalPhoto(photoId, scope)).rejects.toThrow('could not be deleted')
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('keeps authoritative deletion successful if unreferenced-object cleanup fails', async () => {
    mocks.remove.mockRejectedValue(new Error('offline'))
    await expect(deleteFamilyJournalPhoto(photoId, scope)).resolves.toBeUndefined()
  })

  it('does not issue storage cleanup under a newly switched account', async () => {
    mocks.isCurrent.mockReturnValueOnce(true).mockReturnValue(false)
    await deleteFamilyJournalPhoto(photoId, scope)
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('paginates uploader-scoped deletions without conflating two uploaders sharing a photo ID', async () => {
    const otherUploaderId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    mocks.range.mockResolvedValueOnce({ data: Array.from({ length: 500 }, () => ({ photo_id: photoId, uploader_id: userId })), error: null })
      .mockResolvedValueOnce({ data: [
        { photo_id: photoId, uploader_id: otherUploaderId },
        { photo_id: 'invalid', uploader_id: userId },
        { photo_id: photoId, uploader_id: 'invalid' },
        { photo_id: photoId },
      ], error: null })
    await expect(fetchDeletedJournalPhotos(scope)).resolves.toEqual([
      { photoId, uploaderId: userId, ownedByCurrentUser: true },
      { photoId, uploaderId: otherUploaderId, ownedByCurrentUser: false },
    ])
    expect(mocks.from).toHaveBeenCalledWith('deleted_family_journal_photos')
    expect(mocks.select).toHaveBeenCalledWith('photo_id,uploader_id')
    expect(mocks.eq).toHaveBeenCalledWith('circle_id', circleId)
    expect(mocks.order).toHaveBeenCalledWith('uploader_id')
    expect(mocks.range.mock.calls).toEqual([[0, 499], [500, 999]])
  })

  it('does not confuse unavailable deletion metadata with an empty authoritative result', async () => {
    mocks.context.mockResolvedValueOnce(null)
    await expect(fetchDeletedJournalPhotos(scope)).resolves.toBeNull()
    mocks.range.mockResolvedValue({ data: null, error: new Error('offline') })
    await expect(fetchDeletedJournalPhotos(scope)).rejects.toThrow('offline')
    mocks.range.mockResolvedValue({ data: [{ photo_id: photoId, uploader_id: userId }], error: null })
    mocks.isCurrent.mockReturnValue(false)
    await expect(fetchDeletedJournalPhotos(scope)).resolves.toBeNull()
  })

  it('subscribes separately to family deletion hints and suppresses old-account callbacks', async () => {
    const changed = vi.fn()
    const stop = await subscribeToJournalPhotoDeletions(changed, scope)
    expect(mocks.on).toHaveBeenCalledWith('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'deleted_family_journal_photos',
      filter: `circle_id=eq.${circleId}`,
    }, expect.any(Function))
    const callback = mocks.on.mock.calls[0]![2] as () => void
    callback()
    mocks.isCurrent.mockReturnValue(false)
    callback()
    expect(changed).toHaveBeenCalledTimes(1)
    stop()
    expect(mocks.removeChannel).toHaveBeenCalledWith(channel)
  })
})
