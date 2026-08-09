import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capture360Submission } from '../../features/capture'
import type { StoredPanoramaAnnotation } from '../../features/memories/shared'

const mocks = vi.hoisted(() => {
  const momentQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  }
  momentQuery.select.mockReturnValue(momentQuery)
  momentQuery.eq.mockReturnValue(momentQuery)
  momentQuery.order.mockReturnValue(momentQuery)

  const annotationQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    order: vi.fn(),
  }
  annotationQuery.select.mockReturnValue(annotationQuery)
  annotationQuery.eq.mockReturnValue(annotationQuery)
  annotationQuery.in.mockReturnValue(annotationQuery)

  const profileQuery = {
    select: vi.fn(),
    in: vi.fn(),
  }
  profileQuery.select.mockReturnValue(profileQuery)

  const deletionQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
  }
  deletionQuery.select.mockReturnValue(deletionQuery)
  deletionQuery.eq.mockReturnValue(deletionQuery)

  const storageUpload = vi.fn()
  const storageDownload = vi.fn()
  const storageRemove = vi.fn()
  const storageBucket = {
    upload: storageUpload,
    download: storageDownload,
    remove: storageRemove,
  }

  const realtimeChannel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  }
  realtimeChannel.on.mockReturnValue(realtimeChannel)
  realtimeChannel.subscribe.mockReturnValue(realtimeChannel)

  const client = {
    from: vi.fn((table: string) => {
      if (table === 'family_moments') return momentQuery
      if (table === 'family_moment_annotations') return annotationQuery
      if (table === 'family_moment_deletions') return deletionQuery
      return profileQuery
    }),
    storage: { from: vi.fn(() => storageBucket) },
    rpc: vi.fn(),
    channel: vi.fn(() => realtimeChannel),
    removeChannel: vi.fn(),
  }

  return {
    annotationQuery,
    client,
    deletionQuery,
    momentQuery,
    processPanoramaForSharing: vi.fn(),
    profileQuery,
    realtimeChannel,
    storageDownload,
    storageRemove,
    storageUpload,
  }
})

vi.mock('../../lib/supabase', () => ({
  getClerkSupabaseIdentity: () => null,
  getSupabaseClient: () => mocks.client,
}))

vi.mock('./processPanorama', () => ({
  processPanoramaForSharing: mocks.processPanoramaForSharing,
}))

import {
  deleteFamilyMoment,
  fetchFamilyMomentDeletionIds,
  fetchFamilyMoments,
  publishFamilyMoment,
  resumePendingFamilyMomentDeletions,
  subscribeToFamilyMoments,
  type FamilyMomentConnection,
} from './familyMomentService'

const circleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const userId = '10000000-0000-4000-8000-000000000001'
const momentId = '40000000-0000-4000-8000-000000000001'
const textId = '50000000-0000-4000-8000-000000000001'
const voiceId = '50000000-0000-4000-8000-000000000002'
const connection: FamilyMomentConnection = { circleId, userId }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.momentQuery.select.mockReturnValue(mocks.momentQuery)
  mocks.momentQuery.eq.mockReturnValue(mocks.momentQuery)
  mocks.momentQuery.order.mockReturnValue(mocks.momentQuery)
  mocks.annotationQuery.select.mockReturnValue(mocks.annotationQuery)
  mocks.annotationQuery.eq.mockReturnValue(mocks.annotationQuery)
  mocks.annotationQuery.in.mockReturnValue(mocks.annotationQuery)
  mocks.deletionQuery.select.mockReturnValue(mocks.deletionQuery)
  mocks.deletionQuery.eq.mockReturnValue(mocks.deletionQuery)
  mocks.profileQuery.select.mockReturnValue(mocks.profileQuery)
  mocks.realtimeChannel.on.mockReturnValue(mocks.realtimeChannel)
  mocks.realtimeChannel.subscribe.mockReturnValue(mocks.realtimeChannel)
  mocks.storageUpload.mockResolvedValue({ data: {}, error: null })
  mocks.storageRemove.mockResolvedValue({ data: [], error: null })
  mocks.client.rpc.mockResolvedValue({ data: momentId, error: null })
})

describe('family moment annotation sync', () => {
  it('uploads voice blobs to immutable safe paths and atomically finalizes annotations', async () => {
    const viewer = new Blob(['viewer'], { type: 'image/jpeg' })
    const thumbnail = new Blob(['thumbnail'], { type: 'image/jpeg' })
    const voice = new Blob(['voice'], { type: 'audio/mp4' })
    mocks.processPanoramaForSharing.mockResolvedValue({
      viewer,
      thumbnail,
      viewerWidth: 4096,
      viewerHeight: 2048,
      thumbnailWidth: 800,
      thumbnailHeight: 400,
    })

    const annotations: StoredPanoramaAnnotation[] = [
      {
        id: textId,
        kind: 'text',
        pitch: 12,
        yaw: -24,
        message: '  Cake on the table  ',
      },
      {
        id: voiceId,
        kind: 'voice',
        pitch: -4,
        yaw: 31,
        message: 'Dad describing Sunday dinner',
        audioBlob: voice,
        audioMimeType: 'audio/mp4; codecs=mp4a.40.2',
        durationMs: 8_400,
      },
    ]
    const submission: Capture360Submission & {
      annotations: StoredPanoramaAnnotation[]
    } = {
      id: momentId,
      file: new File(['original'], 'original.jpg', { type: 'image/jpeg' }),
      caption: 'Sunday dinner',
      source: 'manual',
      width: 4096,
      height: 2048,
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      annotations,
    }

    await publishFamilyMoment(connection, submission)

    const voicePath = `${circleId}/voice/${userId}/${momentId}-${voiceId}.m4a`
    expect(mocks.storageUpload).toHaveBeenCalledWith(voicePath, voice, {
      cacheControl: '31536000',
      contentType: 'audio/mp4',
      upsert: false,
    })
    expect(mocks.client.rpc).toHaveBeenCalledWith(
      'finalize_360_moment_with_annotations',
      expect.objectContaining({
        p_circle_id: circleId,
        p_moment_id: momentId,
        p_annotations: [
          {
            id: textId,
            kind: 'text',
            pitch: 12,
            yaw: -24,
            message: 'Cake on the table',
            audio_path: null,
            audio_mime_type: null,
            duration_ms: null,
          },
          {
            id: voiceId,
            kind: 'voice',
            pitch: -4,
            yaw: 31,
            message: 'Dad describing Sunday dinner',
            audio_path: voicePath,
            audio_mime_type: 'audio/mp4',
            duration_ms: 8_400,
          },
        ],
      }),
    )
  })

  it('fetches annotation rows and returns downloaded voice blobs nested in the moment', async () => {
    const panorama = new Blob(['panorama'], { type: 'image/jpeg' })
    const voice = new Blob(['voice'], { type: 'audio/mp4' })
    const panoramaPath = `${circleId}/panoramas/${userId}/${momentId}.jpg`
    const voicePath = `${circleId}/voice/${userId}/${momentId}-${voiceId}.m4a`

    mocks.momentQuery.limit.mockResolvedValue({
      data: [
        {
          id: momentId,
          uploader_id: userId,
          capture_kind: 'manual',
          panorama_path: panoramaPath,
          caption: 'Sunday dinner',
          panorama_width: 4096,
          panorama_height: 2048,
          ready_at: '2026-08-28T12:00:00.000Z',
        },
      ],
      error: null,
    })
    mocks.annotationQuery.order.mockResolvedValue({
      data: [
        {
          id: textId,
          moment_id: momentId,
          kind: 'text',
          pitch: 12,
          yaw: -24,
          message: 'Cake on the table',
          audio_path: null,
          audio_mime_type: null,
          duration_ms: null,
          sort_order: 0,
        },
        {
          id: voiceId,
          moment_id: momentId,
          kind: 'voice',
          pitch: -4,
          yaw: 31,
          message: 'Dad describing Sunday dinner',
          audio_path: voicePath,
          audio_mime_type: 'audio/mp4',
          duration_ms: 8_400,
          sort_order: 1,
        },
      ],
      error: null,
    })
    mocks.profileQuery.in.mockResolvedValue({
      data: [{ id: userId, display_name: 'Dad' }],
      error: null,
    })
    mocks.storageDownload.mockImplementation(async (path: string) => {
      if (path === panoramaPath) return { data: panorama, error: null }
      if (path === voicePath) return { data: voice, error: null }
      return { data: null, error: new Error('missing object') }
    })

    await expect(fetchFamilyMoments(connection)).resolves.toEqual([
      expect.objectContaining({
        id: momentId,
        blob: panorama,
        uploaderDisplayName: 'You',
        ownedByCurrentUser: true,
        familySynced: true,
        annotations: [
          {
            id: textId,
            kind: 'text',
            pitch: 12,
            yaw: -24,
            message: 'Cake on the table',
          },
          {
            id: voiceId,
            kind: 'voice',
            pitch: -4,
            yaw: 31,
            message: 'Dad describing Sunday dinner',
            audioBlob: voice,
            audioMimeType: 'audio/mp4',
            durationMs: 8_400,
          },
        ],
      }),
    ])
    expect(mocks.annotationQuery.in).toHaveBeenCalledWith('moment_id', [momentId])
    expect(mocks.storageDownload).toHaveBeenCalledWith(voicePath)
  })

  it('keeps the panorama and note metadata when one voice blob is unavailable', async () => {
    const panorama = new Blob(['panorama'], { type: 'image/jpeg' })
    const panoramaPath = `${circleId}/panoramas/${userId}/${momentId}.jpg`
    const voicePath = `${circleId}/voice/${userId}/${momentId}-${voiceId}.m4a`

    mocks.momentQuery.limit.mockResolvedValue({
      data: [
        {
          id: momentId,
          uploader_id: userId,
          capture_kind: 'manual',
          panorama_path: panoramaPath,
          caption: 'Sunday dinner',
          panorama_width: 4096,
          panorama_height: 2048,
          ready_at: '2026-08-28T12:00:00.000Z',
        },
      ],
      error: null,
    })
    mocks.annotationQuery.order.mockResolvedValue({
      data: [
        {
          id: textId,
          moment_id: momentId,
          kind: 'text',
          pitch: 12,
          yaw: -24,
          message: 'Cake on the table',
          audio_path: null,
          audio_mime_type: null,
          duration_ms: null,
          sort_order: 0,
        },
        {
          id: voiceId,
          moment_id: momentId,
          kind: 'voice',
          pitch: -4,
          yaw: 31,
          message: 'Dad describing Sunday dinner',
          audio_path: voicePath,
          audio_mime_type: 'audio/mp4',
          duration_ms: 8_400,
          sort_order: 1,
        },
      ],
      error: null,
    })
    mocks.profileQuery.in.mockResolvedValue({
      data: [{ id: userId, display_name: 'Dad' }],
      error: null,
    })
    mocks.storageDownload.mockImplementation(async (path: string) => {
      if (path === panoramaPath) return { data: panorama, error: null }
      throw new Error('voice object could not be downloaded')
    })

    await expect(fetchFamilyMoments(connection)).resolves.toEqual([
      expect.objectContaining({
        id: momentId,
        blob: panorama,
        annotations: [
          {
            id: textId,
            kind: 'text',
            pitch: 12,
            yaw: -24,
            message: 'Cake on the table',
          },
          {
            id: voiceId,
            kind: 'voice',
            pitch: -4,
            yaw: 31,
            message: 'Dad describing Sunday dinner',
          },
        ],
      }),
    ])
  })

  it('cleans up only successful uploads when a sibling upload fails', async () => {
    const viewer = new Blob(['viewer'], { type: 'image/jpeg' })
    const thumbnail = new Blob(['thumbnail'], { type: 'image/jpeg' })
    const panoramaPath = `${circleId}/panoramas/${userId}/${momentId}.jpg`
    const thumbnailPath = `${circleId}/thumbnails/${userId}/${momentId}.jpg`
    const uploadError = new Error('thumbnail upload failed')
    mocks.processPanoramaForSharing.mockResolvedValue({
      viewer,
      thumbnail,
      viewerWidth: 4096,
      viewerHeight: 2048,
      thumbnailWidth: 800,
      thumbnailHeight: 400,
    })
    mocks.storageUpload.mockImplementation(async (path: string) =>
      path === thumbnailPath
        ? { data: null, error: uploadError }
        : { data: {}, error: null },
    )

    await expect(
      publishFamilyMoment(connection, {
        id: momentId,
        file: new File(['original'], 'original.jpg', { type: 'image/jpeg' }),
        caption: 'Sunday dinner',
        source: 'manual',
        width: 4096,
        height: 2048,
        createdAt: new Date('2026-08-28T12:00:00.000Z'),
        annotations: [],
      }),
    ).rejects.toBe(uploadError)

    expect(mocks.storageRemove).toHaveBeenCalledWith([panoramaPath])
    expect(mocks.client.rpc).not.toHaveBeenCalled()
  })

  it('best-effort cleans uploaded objects after finalization fails', async () => {
    const viewer = new Blob(['viewer'], { type: 'image/jpeg' })
    const thumbnail = new Blob(['thumbnail'], { type: 'image/jpeg' })
    const panoramaPath = `${circleId}/panoramas/${userId}/${momentId}.jpg`
    const thumbnailPath = `${circleId}/thumbnails/${userId}/${momentId}.jpg`
    const finalizationError = new Error('finalization rejected')
    mocks.processPanoramaForSharing.mockResolvedValue({
      viewer,
      thumbnail,
      viewerWidth: 4096,
      viewerHeight: 2048,
      thumbnailWidth: 800,
      thumbnailHeight: 400,
    })
    mocks.client.rpc.mockResolvedValue({
      data: null,
      error: finalizationError,
    })

    await expect(
      publishFamilyMoment(connection, {
        id: momentId,
        file: new File(['original'], 'original.jpg', { type: 'image/jpeg' }),
        caption: 'Sunday dinner',
        source: 'manual',
        width: 4096,
        height: 2048,
        createdAt: new Date('2026-08-28T12:00:00.000Z'),
        annotations: [],
      }),
    ).rejects.toBe(finalizationError)

    expect(mocks.storageRemove).toHaveBeenCalledWith([
      panoramaPath,
      thumbnailPath,
    ])
  })

  it('refreshes for moment inserts and durable family deletion tombstones', async () => {
    const onChange = vi.fn()
    const subscription = subscribeToFamilyMoments(circleId, onChange)

    expect(mocks.realtimeChannel.on).toHaveBeenCalledTimes(2)
    expect(mocks.realtimeChannel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({ table: 'family_moments' }),
      expect.any(Function),
    )
    expect(mocks.realtimeChannel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({ table: 'family_moment_deletions' }),
      expect.any(Function),
    )
    const insertHandler = mocks.realtimeChannel.on.mock.calls[0][2]
    const deletionHandler = mocks.realtimeChannel.on.mock.calls[1][2]
    insertHandler({ new: { id: momentId } })
    deletionHandler({ new: { moment_id: momentId } })
    expect(onChange).toHaveBeenNthCalledWith(1)
    expect(onChange).toHaveBeenNthCalledWith(2, momentId)
    const onStatus = mocks.realtimeChannel.subscribe.mock.calls[0][0] as (
      status: string,
    ) => void
    onStatus('SUBSCRIBED')
    await expect(subscription.ready).resolves.toBeUndefined()

    subscription.unsubscribe()
    expect(mocks.client.removeChannel).toHaveBeenCalledWith(
      mocks.realtimeChannel,
    )
  })

  it('queries tombstones only for cached IDs so old deletions cannot be truncated', async () => {
    const secondId = '40000000-0000-4000-8000-000000000002'
    mocks.deletionQuery.in.mockResolvedValue({
      data: [{ moment_id: momentId }],
      error: null,
    })

    await expect(
      fetchFamilyMomentDeletionIds(connection, [momentId, secondId]),
    ).resolves.toEqual([momentId])
    expect(mocks.deletionQuery.in).toHaveBeenCalledWith('moment_id', [
      momentId,
      secondId,
    ])
  })

  it('marks an uploader-owned deletion before removing every private media object', async () => {
    const mediaPaths = [
      `${circleId}/panoramas/${userId}/${momentId}.jpg`,
      `${circleId}/thumbnails/${userId}/${momentId}.jpg`,
      `${circleId}/voice/${userId}/${momentId}-${voiceId}.m4a`,
    ]
    mocks.client.rpc.mockImplementation(async (name: string) => {
      if (name === 'begin_delete_own_family_moment') {
        return {
          data: [{ moment_id: momentId, media_paths: mediaPaths }],
          error: null,
        }
      }
      return { data: momentId, error: null }
    })

    await expect(deleteFamilyMoment(connection, momentId)).resolves.toEqual({
      cleanupPending: false,
    })
    expect(mocks.client.rpc).toHaveBeenNthCalledWith(
      1,
      'begin_delete_own_family_moment',
      { p_circle_id: circleId, p_moment_id: momentId },
    )
    expect(mocks.storageRemove).toHaveBeenCalledWith(mediaPaths)
    expect(mocks.client.rpc).toHaveBeenNthCalledWith(
      2,
      'finish_delete_own_family_moment',
      { p_circle_id: circleId, p_moment_id: momentId },
    )
  })

  it('leaves interrupted cleanup pending for a safe reconnect retry', async () => {
    const panoramaPath = `${circleId}/panoramas/${userId}/${momentId}.jpg`
    mocks.client.rpc.mockResolvedValue({
      data: [{ moment_id: momentId, media_paths: [panoramaPath] }],
      error: null,
    })
    mocks.storageRemove.mockResolvedValue({
      data: null,
      error: new Error('offline'),
    })

    await expect(deleteFamilyMoment(connection, momentId)).resolves.toEqual({
      cleanupPending: true,
    })
    expect(mocks.client.rpc).toHaveBeenCalledTimes(1)
  })

  it('resumes pending cleanup and finalization after reconnect', async () => {
    const panoramaPath = `${circleId}/panoramas/${userId}/${momentId}.jpg`
    mocks.client.rpc.mockImplementation(async (name: string) =>
      name === 'list_pending_own_family_moment_deletions'
        ? {
            data: [{ moment_id: momentId, media_paths: [panoramaPath] }],
            error: null,
          }
        : { data: momentId, error: null },
    )

    await expect(
      resumePendingFamilyMomentDeletions(connection),
    ).resolves.toBeUndefined()
    expect(mocks.storageRemove).toHaveBeenCalledWith([panoramaPath])
    expect(mocks.client.rpc).toHaveBeenLastCalledWith(
      'finish_delete_own_family_moment',
      { p_circle_id: circleId, p_moment_id: momentId },
    )
  })

  it('does not touch Storage when the backend rejects deletion ownership', async () => {
    const ownershipError = new Error('moment_uploader_required')
    mocks.client.rpc.mockResolvedValue({ data: null, error: ownershipError })

    await expect(deleteFamilyMoment(connection, momentId)).rejects.toBe(
      ownershipError,
    )
    expect(mocks.storageRemove).not.toHaveBeenCalled()
  })
})
