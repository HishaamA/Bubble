import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  function chain() {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      in: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      range: vi.fn(),
      maybeSingle: vi.fn(),
    }
    query.select.mockReturnValue(query)
    query.eq.mockReturnValue(query)
    query.in.mockReturnValue(query)
    query.order.mockReturnValue(query)
    query.limit.mockReturnValue(query)
    return query
  }
  const membershipQuery = chain()
  const capsulesQuery = chain()
  const itemsQuery = chain()
  const bucket = {
    createSignedUrls: vi.fn(),
    upload: vi.fn(),
    remove: vi.fn(),
  }
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  }
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
    capsulesQuery,
    itemsQuery,
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
  createFamilySpecialCapsule,
  ensureFamilyWeeklyCapsule,
  fetchFamilyCapsules,
  getCapsuleFamilyContext,
  uploadFamilyCapsulePhoto,
} from './capsuleService'

const circleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const capsuleId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const itemId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.membershipQuery.select.mockReturnValue(mocks.membershipQuery)
  mocks.membershipQuery.eq.mockReturnValue(mocks.membershipQuery)
  mocks.membershipQuery.order.mockReturnValue(mocks.membershipQuery)
  mocks.membershipQuery.limit.mockReturnValue(mocks.membershipQuery)
  mocks.capsulesQuery.select.mockReturnValue(mocks.capsulesQuery)
  mocks.capsulesQuery.eq.mockReturnValue(mocks.capsulesQuery)
  mocks.capsulesQuery.order.mockReturnValue(mocks.capsulesQuery)
  mocks.itemsQuery.select.mockReturnValue(mocks.itemsQuery)
  mocks.itemsQuery.eq.mockReturnValue(mocks.itemsQuery)
  mocks.itemsQuery.in.mockReturnValue(mocks.itemsQuery)
  mocks.itemsQuery.order.mockReturnValue(mocks.itemsQuery)
  mocks.itemsQuery.maybeSingle.mockResolvedValue({ data: null, error: null })
  mocks.client.from.mockImplementation((table: string) => {
    if (table === 'circle_members') return mocks.membershipQuery
    if (table === 'family_capsules') return mocks.capsulesQuery
    if (table === 'family_capsule_items') return mocks.itemsQuery
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
})

describe('capsuleService', () => {
  it('uses the server to get one authoritative weekly Capsule', async () => {
    mocks.client.rpc.mockResolvedValue({
      data: { id: capsuleId, week_start: '2026-08-24' },
      error: null,
    })

    await expect(ensureFamilyWeeklyCapsule()).resolves.toEqual({
      id: capsuleId,
      weekStart: '2026-08-24',
    })
    expect(mocks.client.rpc).toHaveBeenCalledWith('get_or_create_weekly_capsule', {
      p_circle_id: circleId,
    })
  })

  it('loads only RLS-visible family photos and creates signed private URLs', async () => {
    const imagePath = `${circleId}/capsule-images/${userId}/${itemId}.jpg`
    const thumbnailPath = `${circleId}/capsule-thumbnails/${userId}/${itemId}.jpg`
    mocks.capsulesQuery.limit.mockResolvedValue({
      data: [{
        id: capsuleId,
        kind: 'weekly',
        title: 'This week',
        week_start: '2026-08-24',
        opens_at: '2026-08-31T00:00:00.000Z',
        closes_at: '2026-08-31T00:00:00.000Z',
        item_count: 3,
        created_at: '2026-08-24T00:00:00.000Z',
        created_by: userId,
        creator: { display_name: 'Simreen' },
      }],
      error: null,
    })
    mocks.itemsQuery.range.mockResolvedValue({
      data: [{
        id: itemId,
        capsule_id: capsuleId,
        image_path: imagePath,
        thumbnail_path: thumbnailPath,
        image_width: 900,
        image_height: 1200,
        caption: 'Pancakes',
        captured_at: '2026-08-29T08:00:00.000Z',
        uploader_id: userId,
        uploader: { display_name: 'Simreen', avatar_path: 'https://images.example/simreen.jpg' },
      }],
      error: null,
    })
    mocks.bucket.createSignedUrls.mockResolvedValue({
      data: [
        { signedUrl: 'https://private.test/photo' },
        { signedUrl: 'https://private.test/thumb' },
      ],
      error: null,
    })

    await expect(fetchFamilyCapsules()).resolves.toEqual([
      expect.objectContaining({
        id: capsuleId,
        familySynced: true,
        totalPhotoCount: 3,
        createdById: userId,
        ownedByCurrentUser: true,
        photos: [
          expect.objectContaining({
            image: 'https://private.test/photo',
            thumbnail: 'https://private.test/thumb',
            contributorName: 'Simreen',
            contributorAvatarUrl: 'https://images.example/simreen.jpg',
            uploaderId: userId,
            ownedByCurrentUser: true,
          }),
        ],
      }),
    ])
    expect(mocks.bucket.createSignedUrls).toHaveBeenCalledWith(
      [imagePath, thumbnailPath],
      3600,
    )
    expect(mocks.itemsQuery.in).toHaveBeenCalledWith('capsule_id', [capsuleId])
    expect(mocks.itemsQuery.range).toHaveBeenCalledWith(0, 499)
    expect(mocks.itemsQuery.select).toHaveBeenCalledWith(expect.stringContaining('(display_name,avatar_path)'))
    expect(mocks.itemsQuery.order).toHaveBeenCalledWith('id', { ascending: true })
  })

  it('returns all visible family contributors rather than only the signed-in uploader', async () => {
    const otherId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const ownItem = {
      id: itemId, capsule_id: capsuleId, image_path: 'own-image', thumbnail_path: 'own-thumb',
      image_width: 900, image_height: 1200, captured_at: '2026-08-29T08:00:00.000Z',
      uploader_id: userId, uploader: { display_name: 'Simreen', avatar_path: 'https://images.example/simreen.jpg' },
    }
    const familyItem = {
      ...ownItem, id: otherId, uploader_id: otherId, image_path: 'family-image', thumbnail_path: 'family-thumb',
      uploader: [{ display_name: 'Mum', avatar_path: 'javascript:alert(1)' }],
    }
    mocks.capsulesQuery.limit.mockResolvedValue({ data: [{
      id: capsuleId, kind: 'weekly', title: 'This week', week_start: '2026-08-24',
      opens_at: '2026-08-31T00:00:00.000Z', closes_at: '2026-08-31T00:00:00.000Z',
      item_count: 2, created_at: '2026-08-24T00:00:00.000Z',
    }], error: null })
    mocks.itemsQuery.range.mockResolvedValue({ data: [ownItem, familyItem], error: null })
    mocks.bucket.createSignedUrls.mockImplementation(async (paths: string[]) => ({
      data: paths.map((path) => ({ signedUrl: `https://private.test/${path}` })), error: null,
    }))

    const [capsule] = await fetchFamilyCapsules()
    expect(capsule.photos).toEqual([
      expect.objectContaining({ contributorName: 'Simreen', contributorAvatarUrl: 'https://images.example/simreen.jpg', ownedByCurrentUser: true }),
      expect.objectContaining({ contributorName: 'Mum', contributorAvatarUrl: undefined, ownedByCurrentUser: false }),
    ])
    expect(mocks.itemsQuery.eq).toHaveBeenCalledWith('circle_id', circleId)
    expect(mocks.itemsQuery.eq).not.toHaveBeenCalledWith('uploader_id', expect.anything())
  })

  it('uses a stable client ID when retrying special Capsule creation', async () => {
    mocks.client.rpc.mockResolvedValue({ data: capsuleId, error: null })

    await expect(createFamilySpecialCapsule(
      'Grandpa’s 60th',
      '2026-09-20T20:00:00.000Z',
      capsuleId,
    )).resolves.toBe(capsuleId)

    expect(mocks.client.rpc).toHaveBeenCalledWith('create_special_capsule', {
      p_circle_id: circleId,
      p_title: 'Grandpa’s 60th',
      p_opens_at: '2026-09-20T20:00:00.000Z',
      p_capsule_id: capsuleId,
    })
  })

  it('rejects a deletion caller from another account/family namespace', async () => {
    await expect(getCapsuleFamilyContext(`another-user:${circleId}`)).resolves.toBeNull()
    await expect(getCapsuleFamilyContext('user_test:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')).resolves.toBeNull()
    expect(mocks.client.rpc).not.toHaveBeenCalled()
  })

  it('invalidates a resolved family context as soon as the account changes', async () => {
    const context = await getCapsuleFamilyContext(`user_test:${circleId}`)
    expect(context?.isCurrent()).toBe(true)
    mocks.getClerkSupabaseIdentity.mockReturnValue({ subject: 'another-user' })
    expect(context?.isCurrent()).toBe(false)
  })

  it('uploads an ordinary portrait image to canonical private paths before finalizing', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(itemId)
    mocks.bucket.upload.mockResolvedValue({ data: {}, error: null })
    mocks.bucket.remove.mockResolvedValue({ data: {}, error: null })
    mocks.itemsQuery.maybeSingle.mockResolvedValue({ data: null, error: null })
    mocks.client.rpc.mockResolvedValue({ data: itemId, error: null })
    const image = new Blob(['image'], { type: 'image/jpeg' })
    const thumbnail = new Blob(['thumb'], { type: 'image/jpeg' })

    await expect(uploadFamilyCapsulePhoto({
      capsuleId,
      itemId,
      photo: {
        image,
        thumbnail,
        width: 900,
        height: 1200,
        thumbnailWidth: 420,
        thumbnailHeight: 560,
      },
      caption: 'Portrait Saturday',
      capturedAt: '2026-08-29T12:00:00.000Z',
    })).resolves.toBe(itemId)

    expect(mocks.bucket.upload).toHaveBeenNthCalledWith(
      1,
      `${circleId}/capsule-images/${userId}/${itemId}.jpg`,
      image,
      expect.objectContaining({ contentType: 'image/jpeg', upsert: false }),
    )
    expect(mocks.bucket.upload).toHaveBeenNthCalledWith(
      2,
      `${circleId}/capsule-thumbnails/${userId}/${itemId}.jpg`,
      thumbnail,
      expect.objectContaining({ contentType: 'image/jpeg', upsert: false }),
    )
    expect(mocks.client.rpc).toHaveBeenCalledWith(
      'finalize_capsule_photo',
      expect.objectContaining({
        p_image_width: 900,
        p_image_height: 1200,
        p_thumbnail_width: 420,
        p_thumbnail_height: 560,
        p_item_id: itemId,
      }),
    )
  })

  it('treats a finalized stable item ID as an idempotent upload retry', async () => {
    mocks.itemsQuery.maybeSingle.mockResolvedValue({
      data: { id: itemId },
      error: null,
    })

    await expect(uploadFamilyCapsulePhoto({
      capsuleId,
      itemId,
      photo: {
        image: new Blob(['image'], { type: 'image/jpeg' }),
        thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }),
        width: 900,
        height: 1200,
        thumbnailWidth: 420,
        thumbnailHeight: 560,
      },
      caption: 'Already there',
      capturedAt: '2026-08-29T12:00:00.000Z',
    })).resolves.toBe(itemId)

    expect(mocks.bucket.upload).not.toHaveBeenCalled()
    expect(mocks.client.rpc).not.toHaveBeenCalledWith(
      'finalize_capsule_photo',
      expect.anything(),
    )
  })
})
