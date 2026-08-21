import { beforeEach, describe, expect, it, vi } from 'vitest'

const serviceMocks = vi.hoisted(() => {
  const membershipQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn(),
  }
  membershipQuery.select.mockImplementation(() => membershipQuery)
  membershipQuery.eq.mockImplementation(() => membershipQuery)
  membershipQuery.order.mockImplementation(() => membershipQuery)
  membershipQuery.limit.mockImplementation(() => membershipQuery)

  const eventsQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    gte: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  }
  eventsQuery.select.mockImplementation(() => eventsQuery)
  eventsQuery.eq.mockImplementation(() => eventsQuery)
  eventsQuery.gte.mockImplementation(() => eventsQuery)
  eventsQuery.order.mockImplementation(() => eventsQuery)

  const realtimeChannel = { topic: 'family-events' }
  const channelBuilder = {
    on: vi.fn(),
    subscribe: vi.fn(() => realtimeChannel),
  }
  channelBuilder.on.mockImplementation(() => channelBuilder)

  return {
    channel: vi.fn(() => channelBuilder),
    channelBuilder,
    from: vi.fn((table: string) =>
      table === 'events' ? eventsQuery : membershipQuery,
    ),
    eventsQuery,
    membershipQuery,
    realtimeChannel,
    removeChannel: vi.fn(),
    rpc: vi.fn(),
  }
})

const identityMocks = vi.hoisted(() => ({
  getClerkSupabaseIdentity: vi.fn((): { subject: string } | null => ({
    subject: 'user_clerk_alice',
  })),
}))

vi.mock('../../lib/supabase', () => ({
  getClerkSupabaseIdentity: identityMocks.getClerkSupabaseIdentity,
  getSupabaseClient: () => ({
    channel: serviceMocks.channel,
    from: serviceMocks.from,
    removeChannel: serviceMocks.removeChannel,
    rpc: serviceMocks.rpc,
  }),
}))

const persistenceMocks = vi.hoisted(() => ({
  bootstrapCurrentClerkProfile: vi.fn(),
}))

vi.mock('../../services/persistence', () => persistenceMocks)

import {
  createFamilyEvent,
  deleteFamilyEvent,
  fetchFamilyEvents,
  subscribeToFamilyEvents,
  syncEventReminder,
  updateFamilyEventDetails,
} from './eventService'

const userId = '10000000-0000-4000-8000-000000000001'
const circleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const eventId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

beforeEach(() => {
  vi.clearAllMocks()
  identityMocks.getClerkSupabaseIdentity.mockReturnValue({
    subject: 'user_clerk_alice',
  })
  persistenceMocks.bootstrapCurrentClerkProfile.mockResolvedValue({
    userId,
  })
  serviceMocks.membershipQuery.maybeSingle.mockResolvedValue({
    data: { circle_id: circleId },
    error: null,
  })
  serviceMocks.rpc.mockResolvedValue({ data: eventId, error: null })
  serviceMocks.eventsQuery.limit.mockResolvedValue({ data: [], error: null })
})

describe('eventService', () => {
  it('normalizes a valid event before sending it to the membership-scoped RPC', async () => {
    const result = await createFamilyEvent({
      title: '  Cousins picnic  ',
      startsAt: '2099-12-20T16:30:00+04:00',
      location: '  Creek Park  ',
      details: '  Bring a blanket.  ',
    })

    expect(result).toEqual({ id: eventId, synced: true })
    expect(serviceMocks.rpc).toHaveBeenCalledWith('create_family_event', {
      p_circle_id: circleId,
      p_title: 'Cousins picnic',
      p_starts_at: '2099-12-20T12:30:00.000Z',
      p_location: 'Creek Park',
      p_details: 'Bring a blanket.',
      p_remind_before: null,
    })
  })

  it('rejects invalid input before reading a session or attempting a write', async () => {
    await expect(
      createFamilyEvent({
        title: 'Dinner',
        startsAt: 'not-a-date',
        location: 'Home',
      }),
    ).rejects.toThrow('Choose a valid date and time')

    await expect(
      createFamilyEvent({
        title: '   ',
        startsAt: '2099-12-20T16:30:00+04:00',
        location: 'Home',
      }),
    ).rejects.toThrow('Add an event title')

    expect(
      persistenceMocks.bootstrapCurrentClerkProfile,
    ).not.toHaveBeenCalled()
    expect(serviceMocks.rpc).not.toHaveBeenCalled()
  })

  it('syncs reminders only for server-issued UUID event ids', async () => {
    await expect(syncEventReminder('family-local-event', true)).resolves.toBe(false)
    expect(serviceMocks.rpc).not.toHaveBeenCalled()

    await expect(syncEventReminder(eventId, true)).resolves.toBe(true)
    expect(serviceMocks.rpc).toHaveBeenLastCalledWith('set_event_reminder', {
      p_event_id: eventId,
      p_remind_before: '1 hour',
    })

    await expect(syncEventReminder(eventId, false)).resolves.toBe(true)
    expect(serviceMocks.rpc).toHaveBeenLastCalledWith('cancel_event_reminder', {
      p_event_id: eventId,
    })
  })

  it('completes only server-backed events through the membership-scoped RPC', async () => {
    await expect(deleteFamilyEvent('family-local-event')).resolves.toBe(false)
    expect(serviceMocks.rpc).not.toHaveBeenCalled()

    serviceMocks.rpc.mockResolvedValueOnce({ data: true, error: null })
    await expect(deleteFamilyEvent(eventId)).resolves.toBe(true)
    expect(serviceMocks.rpc).toHaveBeenCalledWith('complete_family_event', {
      p_event_id: eventId,
    })
  })

  it('updates shared details only for authenticated server-backed events', async () => {
    await expect(
      updateFamilyEventDetails('family-local-event', 'local details'),
    ).resolves.toBe(false)
    expect(serviceMocks.rpc).not.toHaveBeenCalled()

    identityMocks.getClerkSupabaseIdentity.mockReturnValueOnce(null)
    await expect(
      updateFamilyEventDetails(eventId, 'signed-out details'),
    ).resolves.toBe(false)
    expect(serviceMocks.rpc).not.toHaveBeenCalled()

    serviceMocks.rpc.mockResolvedValueOnce({ data: true, error: null })
    await expect(
      updateFamilyEventDetails(eventId, '  shared checklist  '),
    ).resolves.toBe(true)
    expect(serviceMocks.rpc).toHaveBeenCalledWith(
      'update_family_event_details',
      {
        p_event_id: eventId,
        p_details: 'shared checklist',
      },
    )
  })

  it('rejects oversized event details before calling the shared RPC', async () => {
    await expect(
      updateFamilyEventDetails(eventId, 'x'.repeat(2_001)),
    ).rejects.toThrow('2,000 characters or fewer')
    expect(serviceMocks.rpc).not.toHaveBeenCalled()
  })

  it('loads only valid upcoming event rows from the current family circle', async () => {
    serviceMocks.eventsQuery.limit.mockResolvedValue({
      data: [
        {
          id: eventId,
          title: 'Family hike',
          starts_at: '2099-12-20T12:30:00.000Z',
          location: '  Hatta  ',
          details: null,
        },
        {
          id: 'not-a-uuid',
          title: 'Malformed row',
          starts_at: '2099-12-20T12:30:00.000Z',
          location: null,
          details: null,
        },
      ],
      error: null,
    })

    await expect(fetchFamilyEvents()).resolves.toEqual([
      {
        id: eventId,
        title: 'Family hike',
        startsAt: '2099-12-20T12:30:00.000Z',
        location: 'Hatta',
        details: null,
      },
    ])
    expect(serviceMocks.from).toHaveBeenCalledWith('events')
    expect(serviceMocks.eventsQuery.eq).toHaveBeenCalledWith(
      'circle_id',
      circleId,
    )
  })

  it('subscribes to changes only within the current family circle', async () => {
    const onChange = vi.fn()
    const unsubscribe = await subscribeToFamilyEvents(onChange)

    expect(serviceMocks.channel).toHaveBeenCalledWith(
      `family-events:${circleId}`,
    )
    expect(serviceMocks.channelBuilder.on).toHaveBeenCalledWith(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'events',
        filter: `circle_id=eq.${circleId}`,
      },
      onChange,
    )

    unsubscribe()
    expect(serviceMocks.removeChannel).toHaveBeenCalledWith(
      serviceMocks.realtimeChannel,
    )
  })
})
