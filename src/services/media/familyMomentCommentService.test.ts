import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const commentsQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  }
  commentsQuery.select.mockReturnValue(commentsQuery)
  commentsQuery.eq.mockReturnValue(commentsQuery)
  commentsQuery.order.mockReturnValue(commentsQuery)

  const realtimeChannel = { topic: 'family-moment-comments' }
  const channelBuilder = {
    on: vi.fn(),
    subscribe: vi.fn(() => realtimeChannel),
  }
  channelBuilder.on.mockReturnValue(channelBuilder)

  const client = {
    channel: vi.fn(() => channelBuilder),
    from: vi.fn(() => commentsQuery),
    removeChannel: vi.fn(),
    rpc: vi.fn(),
  }

  return {
    channelBuilder,
    client,
    commentsQuery,
    getClerkSupabaseIdentity: vi.fn(),
    getFamilyMomentConnection: vi.fn(),
    realtimeChannel,
  }
})

vi.mock('../../lib/supabase', () => ({
  getClerkSupabaseIdentity: mocks.getClerkSupabaseIdentity,
  getSupabaseClient: () => mocks.client,
}))

vi.mock('./familyMomentService', () => ({
  getFamilyMomentConnection: mocks.getFamilyMomentConnection,
}))

import {
  addFamilyMomentComment,
  fetchFamilyMomentComments,
  subscribeToFamilyMomentComments,
} from './familyMomentCommentService'

const circleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const momentId = '40000000-0000-4000-8000-000000000001'
const annotationId = 'table-note'
const commentId = '60000000-0000-4000-8000-000000000001'
const authorId = '10000000-0000-4000-8000-000000000001'

const remoteRow = {
  id: commentId,
  moment_id: momentId,
  annotation_id: annotationId,
  author_id: authorId,
  author_display_name: 'Simreen',
  body: 'That vase was from Grandma.',
  created_at: '2026-08-28T12:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem('kinsphere:family-moment-comments:v1', '[]')
  mocks.commentsQuery.select.mockReturnValue(mocks.commentsQuery)
  mocks.commentsQuery.eq.mockReturnValue(mocks.commentsQuery)
  mocks.commentsQuery.order.mockReturnValue(mocks.commentsQuery)
  mocks.commentsQuery.limit.mockResolvedValue({ data: [], error: null })
  mocks.channelBuilder.on.mockReturnValue(mocks.channelBuilder)
  mocks.channelBuilder.subscribe.mockReturnValue(mocks.realtimeChannel)
  mocks.getClerkSupabaseIdentity.mockReturnValue({
    subject: 'user_clerk_simreen',
    displayName: 'Simreen',
  })
  mocks.getFamilyMomentConnection.mockResolvedValue(null)
  mocks.client.rpc.mockResolvedValue({ data: [remoteRow], error: null })
})

describe('family moment comment persistence', () => {
  it('keeps whole-photo and embedded-note comments in the durable local preview fallback', async () => {
    const wholePhoto = await addFamilyMomentComment({
      momentId: 'sunday-dinner',
      body: '  I miss these dinners.  ',
    })
    const reply = await addFamilyMomentComment({
      momentId: 'sunday-dinner',
      annotationId: '  Table-Note  ',
      body: 'That belonged to Grandma.',
      authorDisplayName: '  Simreen  ',
    })

    expect(wholePhoto).toMatchObject({
      momentId: 'sunday-dinner',
      annotationId: null,
      body: 'I miss these dinners.',
      authorDisplayName: 'Simreen',
      authorId: null,
      synced: false,
    })
    expect(reply).toMatchObject({
      annotationId,
      body: 'That belonged to Grandma.',
      synced: false,
    })
    await expect(fetchFamilyMomentComments('sunday-dinner')).resolves.toEqual([
      wholePhoto,
      reply,
    ])
    expect(JSON.parse(localStorage.getItem('kinsphere:family-moment-comments:v1') ?? '[]')).toHaveLength(2)
  })

  it('validates body, author name, and annotation target before any backend write', async () => {
    await expect(
      addFamilyMomentComment({ momentId, body: '   ' }),
    ).rejects.toThrow('between 1 and 500')
    await expect(
      addFamilyMomentComment({
        momentId,
        annotationId: '../another-moment',
        body: 'Nope',
      }),
    ).rejects.toThrow('valid embedded note')
    await expect(
      addFamilyMomentComment({
        momentId,
        body: 'Hello',
        authorDisplayName: 'A'.repeat(81),
      }),
    ).rejects.toThrow('80 characters')

    expect(mocks.getFamilyMomentConnection).not.toHaveBeenCalled()
    expect(mocks.client.rpc).not.toHaveBeenCalled()
  })

  it('uses the membership-scoped RPC and trusts only its server-authored row', async () => {
    mocks.getFamilyMomentConnection.mockResolvedValue({ circleId, userId: authorId })

    await expect(
      addFamilyMomentComment({
        momentId,
        annotationId: ` ${annotationId} `,
        authorDisplayName: 'Spoofed local name',
        body: '  That vase was from Grandma.  ',
      }),
    ).resolves.toEqual({
      id: commentId,
      momentId,
      annotationId,
      authorId,
      authorDisplayName: 'Simreen',
      body: 'That vase was from Grandma.',
      createdAt: '2026-08-28T12:00:00.000Z',
      synced: true,
    })

    expect(mocks.client.rpc).toHaveBeenCalledWith('add_family_moment_comment', {
      p_circle_id: circleId,
      p_moment_id: momentId,
      p_annotation_id: annotationId,
      p_body: 'That vase was from Grandma.',
    })
  })

  it('loads only well-formed comments for the exact family moment', async () => {
    mocks.getFamilyMomentConnection.mockResolvedValue({ circleId, userId: authorId })
    mocks.commentsQuery.limit.mockResolvedValue({
      data: [
        remoteRow,
        { ...remoteRow, id: 'not-a-uuid', body: 'Malformed' },
        {
          ...remoteRow,
          id: '60000000-0000-4000-8000-000000000002',
          moment_id: '40000000-0000-4000-8000-000000000002',
        },
      ],
      error: null,
    })

    await expect(fetchFamilyMomentComments(momentId)).resolves.toEqual([
      {
        id: commentId,
        momentId,
        annotationId,
        authorId,
        authorDisplayName: 'Simreen',
        body: 'That vase was from Grandma.',
        createdAt: '2026-08-28T12:00:00.000Z',
        synced: true,
      },
    ])
    expect(mocks.client.from).toHaveBeenCalledWith('family_moment_comments')
    expect(mocks.commentsQuery.eq).toHaveBeenCalledWith('circle_id', circleId)
    expect(mocks.commentsQuery.eq).toHaveBeenCalledWith('moment_id', momentId)
  })

  it('subscribes to exact-moment Realtime inserts and removes the channel', async () => {
    mocks.getFamilyMomentConnection.mockResolvedValue({ circleId, userId: authorId })
    const onChange = vi.fn()

    const unsubscribe = await subscribeToFamilyMomentComments(momentId, onChange)

    expect(mocks.client.channel).toHaveBeenCalledWith(
      `family-moment-comments:${momentId}`,
    )
    expect(mocks.channelBuilder.on).toHaveBeenCalledWith(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'family_moment_comments',
        filter: `moment_id=eq.${momentId}`,
      },
      onChange,
    )

    unsubscribe()
    expect(mocks.client.removeChannel).toHaveBeenCalledWith(
      mocks.realtimeChannel,
    )
  })

  it('notifies local subscribers immediately after a preview comment is added', async () => {
    const onChange = vi.fn()
    const unsubscribe = await subscribeToFamilyMomentComments(
      'sunday-dinner',
      onChange,
    )

    await addFamilyMomentComment({
      momentId: 'sunday-dinner',
      body: 'Save me a seat.',
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})
