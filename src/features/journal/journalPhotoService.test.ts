import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  function chain() {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      range: vi.fn(),
      maybeSingle: vi.fn(),
    }
    query.select.mockReturnValue(query)
    query.eq.mockReturnValue(query)
    query.order.mockReturnValue(query)
    query.limit.mockReturnValue(query)
    return query
  }
  const membershipQuery = chain()
  const photosQuery = chain()
  const bucket = {
    createSignedUrls: vi.fn(),
    upload: vi.fn(),
    remove: vi.fn(),
  }
  const channel = { on: vi.fn(), subscribe: vi.fn() }
  channel.on.mockReturnValue(channel)
  channel.subscribe.mockReturnValue(channel)
  const client = {
    from: vi.fn(),
    rpc: vi.fn(),
    storage: { from: vi.fn() },
    channel: vi.fn(),
    removeChannel: vi.fn(),
  }
  return {
    membershipQuery,
    photosQuery,
    bucket,
    channel,
    client,
    getSupabaseClient: vi.fn(),
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
  fetchFamilyJournalPhotos,
  uploadFamilyJournalPhoto,
} from './journalPhotoService'

const circleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const photoId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

beforeEach(() => {
  vi.clearAllMocks()
  for (const query of [mocks.membershipQuery, mocks.photosQuery]) {
    query.select.mockReturnValue(query)
    query.eq.mockReturnValue(query)
    query.order.mockReturnValue(query)
    query.limit.mockReturnValue(query)
  }
  mocks.client.from.mockImplementation((table: string) => {
    if (table === 'circle_members') return mocks.membershipQuery
    if (table === 'family_journal_photos') return mocks.photosQuery
    throw new Error(`Unexpected table ${table}`)
  })
  mocks.client.storage.from.mockReturnValue(mocks.bucket)
  mocks.client.channel.mockReturnValue(mocks.channel)
  mocks.getSupabaseClient.mockReturnValue(mocks.client)
  mocks.getClerkSupabaseIdentity.mockReturnValue({ subject: 'user_test' })
  mocks.bootstrapCurrentClerkProfile.mockResolvedValue({ userId })
  mocks.membershipQuery.maybeSingle.mockResolvedValue({
    data: { circle_id: circleId },
    error: null,
  })
  mocks.photosQuery.maybeSingle.mockResolvedValue({ data: null, error: null })
  mocks.bucket.remove.mockResolvedValue({ data: {}, error: null })
})

describe('journalPhotoService', () => {
  it('loads RLS-visible family photos through short-lived signed URLs', async () => {
    const imagePath = `${circleId}/journal-images/${userId}/${photoId}.jpg`
    const thumbnailPath = `${circleId}/journal-thumbnails/${userId}/${photoId}.jpg`
    mocks.photosQuery.range.mockResolvedValue({
      data: [{
        id: photoId,
        image_path: imagePath,
        thumbnail_path: thumbnailPath,
        image_width: 1200,
        image_height: 900,
        thumbnail_width: 400,
        thumbnail_height: 300,
        caption: 'At the park',
        captured_at: '2020-01-01T12:00:00.000Z',
        uploader_id: userId,
        uploader: { display_name: 'Maya' },
      }],
      error: null,
    })
    mocks.bucket.createSignedUrls.mockResolvedValue({
      data: [
        { signedUrl: 'https://private.test/full' },
        { signedUrl: 'https://private.test/thumb' },
      ],
      error: null,
    })

    await expect(fetchFamilyJournalPhotos()).resolves.toEqual([
      expect.objectContaining({
        id: photoId,
        image: 'https://private.test/full',
        thumbnail: 'https://private.test/thumb',
        contributorName: 'Maya',
        ownedByCurrentUser: true,
        syncStatus: 'synced',
      }),
    ])
    expect(mocks.photosQuery.eq).toHaveBeenCalledWith('circle_id', circleId)
    expect(mocks.photosQuery.range).toHaveBeenCalledWith(0, 499)
  })

  it('uploads metadata-stripped images to canonical Journal paths before finalizing', async () => {
    const image = new Blob(['image'], { type: 'image/jpeg' })
    const thumbnail = new Blob(['thumb'], { type: 'image/jpeg' })
    mocks.bucket.upload.mockResolvedValue({ data: {}, error: null })
    mocks.client.rpc.mockResolvedValue({ data: photoId, error: null })

    await expect(uploadFamilyJournalPhoto({
      photoId,
      photo: {
        image,
        thumbnail,
        width: 1200,
        height: 900,
        thumbnailWidth: 400,
        thumbnailHeight: 300,
      },
      caption: 'At the park',
      capturedAt: '2020-01-01T12:00:00.000Z',
    })).resolves.toBe(photoId)

    expect(mocks.bucket.upload).toHaveBeenNthCalledWith(
      1,
      `${circleId}/journal-images/${userId}/${photoId}.jpg`,
      image,
      expect.objectContaining({ contentType: 'image/jpeg', upsert: false }),
    )
    expect(mocks.bucket.upload).toHaveBeenNthCalledWith(
      2,
      `${circleId}/journal-thumbnails/${userId}/${photoId}.jpg`,
      thumbnail,
      expect.objectContaining({ contentType: 'image/jpeg', upsert: false }),
    )
    expect(mocks.client.rpc).toHaveBeenCalledWith(
      'finalize_journal_photo',
      expect.objectContaining({
        p_circle_id: circleId,
        p_photo_id: photoId,
        p_image_width: 1200,
        p_thumbnail_width: 400,
      }),
    )
  })

  it('keeps upload offline when no configured authenticated family exists', async () => {
    mocks.getSupabaseClient.mockReturnValue(null)

    await expect(fetchFamilyJournalPhotos()).resolves.toBeNull()
    await expect(uploadFamilyJournalPhoto({
      photoId,
      photo: {
        image: new Blob(['image']),
        thumbnail: new Blob(['thumb']),
        width: 1200,
        height: 900,
        thumbnailWidth: 400,
        thumbnailHeight: 300,
      },
      caption: '',
      capturedAt: '2020-01-01T12:00:00.000Z',
    })).resolves.toBeNull()
    expect(mocks.bucket.upload).not.toHaveBeenCalled()
  })

  it('refuses an old upload batch after the active account or family changes', async () => {
    const oldNamespace = `different-user:${circleId}`

    await expect(fetchFamilyJournalPhotos(oldNamespace)).resolves.toBeNull()
    await expect(uploadFamilyJournalPhoto({
      photoId,
      photo: {
        image: new Blob(['image']),
        thumbnail: new Blob(['thumb']),
        width: 1200,
        height: 900,
        thumbnailWidth: 400,
        thumbnailHeight: 300,
      },
      caption: '',
      capturedAt: '2020-01-01T12:00:00.000Z',
      expectedCacheNamespace: oldNamespace,
    })).resolves.toBeNull()
    expect(mocks.photosQuery.range).not.toHaveBeenCalled()
    expect(mocks.bucket.upload).not.toHaveBeenCalled()
  })
})
