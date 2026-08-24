import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reminderMocks = vi.hoisted(() => ({
  native: true,
  platform: 'android',
  isPluginAvailable: vi.fn(() => true),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  schedule: vi.fn(),
  getPending: vi.fn(),
  getAll: vi.fn(),
  cancel: vi.fn(),
  removeDeliveredNotificationsById: vi.fn(),
  checkExactNotificationSetting: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => reminderMocks.native,
    isPluginAvailable: reminderMocks.isPluginAvailable,
    getPlatform: () => reminderMocks.platform,
  },
}))

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: reminderMocks.checkPermissions,
    requestPermissions: reminderMocks.requestPermissions,
    schedule: reminderMocks.schedule,
    getPending: reminderMocks.getPending,
    getAll: reminderMocks.getAll,
    cancel: reminderMocks.cancel,
    removeDeliveredNotificationsById:
      reminderMocks.removeDeliveredNotificationsById,
    checkExactNotificationSetting:
      reminderMocks.checkExactNotificationSetting,
  },
}))

import {
  cancelEventReminder,
  cleanupEventReminderAccount,
  enableEventReminder,
  eventReminderNotificationId,
  readDesiredEventReminders,
  reconcileEventReminders,
  reminderLeadTime,
  restoreEventReminders,
  transitionEventReminderAccount,
  type ReminderEvent,
} from './eventReminders'

const event: ReminderEvent = {
  id: 'family-picnic',
  title: 'Family picnic',
  startsAt: '2026-08-27T15:00:00.000Z',
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'))
  vi.clearAllMocks()
  reminderMocks.native = true
  reminderMocks.platform = 'android'
  reminderMocks.isPluginAvailable.mockReturnValue(true)
  reminderMocks.checkPermissions.mockResolvedValue({ display: 'granted' })
  reminderMocks.requestPermissions.mockResolvedValue({ display: 'granted' })
  reminderMocks.schedule.mockResolvedValue({ notifications: [] })
  reminderMocks.getPending.mockResolvedValue({ notifications: [] })
  reminderMocks.getAll.mockResolvedValue({ notifications: [] })
  reminderMocks.cancel.mockResolvedValue(undefined)
  reminderMocks.removeDeliveredNotificationsById.mockResolvedValue(undefined)
  reminderMocks.checkExactNotificationSetting.mockResolvedValue({
    exact_alarm: 'granted',
  })
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('eventReminderNotificationId', () => {
  it('is stable, account-scoped, and always fits an Android signed integer', () => {
    const first = eventReminderNotificationId(event.id, 'user_a')
    expect(eventReminderNotificationId(event.id, 'user_a')).toBe(first)
    expect(eventReminderNotificationId(event.id, 'user_b')).not.toBe(first)

    for (let index = 0; index < 10_000; index += 1) {
      const id = eventReminderNotificationId(`event-${index}`, 'user_a')
      expect(id).toBeGreaterThan(0)
      expect(id).toBeLessThanOrEqual(2_147_483_647)
    }
  })
})

describe('native event reminders', () => {
  it('requests display permission from a tap and schedules a private exact alert', async () => {
    reminderMocks.checkPermissions.mockResolvedValue({ display: 'prompt' })

    const result = await enableEventReminder(event, 'user_a')

    expect(reminderMocks.requestPermissions).toHaveBeenCalledTimes(1)
    expect(reminderMocks.cancel).toHaveBeenCalledTimes(1)
    expect(reminderMocks.schedule).toHaveBeenCalledTimes(1)
    const notification = reminderMocks.schedule.mock.calls[0][0].notifications[0]
    expect(notification).toMatchObject({
      id: eventReminderNotificationId(event.id, 'user_a'),
      title: 'Family time soon',
      body: 'A family event starts in one hour. Open Bubble for the details.',
      sound: 'default',
      autoCancel: true,
      isExactNotification: true,
      isExactMandatory: false,
      schedule: { allowWhileIdle: true },
      extra: {
        kind: 'family-event-reminder',
        eventId: event.id,
        startsAt: event.startsAt,
      },
    })
    expect(notification.body).not.toContain(event.title)
    expect(notification.schedule.at.getTime()).toBe(
      new Date(event.startsAt).getTime() - reminderLeadTime,
    )
    expect(result.mode).toBe('native')
    expect(result.message).toMatch(/installed app is not open/i)
  })

  it('keeps the reminder in-app when phone notification permission is denied', async () => {
    reminderMocks.checkPermissions.mockResolvedValue({ display: 'denied' })

    const result = await enableEventReminder(event, 'user_a')

    expect(reminderMocks.requestPermissions).not.toHaveBeenCalled()
    expect(reminderMocks.schedule).not.toHaveBeenCalled()
    expect(result.mode).toBe('in-app')
    expect(result.message).toMatch(/phone Settings/i)
  })

  it('reports Android exact-alarm fallback without claiming exact delivery', async () => {
    reminderMocks.schedule.mockResolvedValue({
      notifications: [],
      warning: { code: 'OS-PLUG-LNOT-0001', message: 'Scheduled inexactly' },
    })

    const result = await enableEventReminder(event, 'user_a')

    expect(result.mode).toBe('native')
    expect(result.message).toMatch(/may deliver it near the requested time/i)
  })

  it('reconciles stale native schedules without prompting or opening settings', async () => {
    const id = eventReminderNotificationId(event.id, 'user_a')
    reminderMocks.checkExactNotificationSetting.mockResolvedValue({
      exact_alarm: 'denied',
    })
    reminderMocks.getPending.mockResolvedValue({
      notifications: [
        {
          id,
          title: 'Family time soon',
          body: 'old body',
          schedule: { at: new Date('2026-08-27T13:00:00.000Z') },
          extra: { kind: 'family-event-reminder', eventId: event.id },
        },
      ],
    })

    await restoreEventReminders([event], 'user_a')

    expect(reminderMocks.requestPermissions).not.toHaveBeenCalled()
    expect(reminderMocks.cancel).toHaveBeenCalledWith({
      notifications: expect.arrayContaining([{ id }]),
    })
    const notification = reminderMocks.schedule.mock.calls[0][0].notifications[0]
    expect(notification.id).toBe(id)
    expect(notification.isExactNotification).toBe(false)
    expect(notification.schedule.allowWhileIdle).toBe(true)
  })

  it('leaves an already-correct pending reminder in place', async () => {
    const id = eventReminderNotificationId(event.id, 'user_a')
    reminderMocks.getPending.mockResolvedValue({
      notifications: [
        {
          id,
          title: 'Family time soon',
          body: 'A family event starts in one hour. Open Bubble for the details.',
          schedule: {
            at: new Date(new Date(event.startsAt).getTime() - reminderLeadTime),
          },
          extra: {
            kind: 'family-event-reminder',
            eventId: event.id,
            startsAt: event.startsAt,
          },
        },
      ],
    })

    await restoreEventReminders([event], 'user_a')

    expect(reminderMocks.requestPermissions).not.toHaveBeenCalled()
    expect(reminderMocks.cancel).not.toHaveBeenCalled()
    expect(reminderMocks.schedule).not.toHaveBeenCalled()
  })

  it('cancels pending and already-delivered notifications for the account', async () => {
    const id = eventReminderNotificationId(event.id, 'user_a')

    await cancelEventReminder(event.id, 'user_a')

    expect(reminderMocks.cancel).toHaveBeenCalledWith({
      notifications: expect.arrayContaining([{ id }]),
    })
    expect(reminderMocks.removeDeliveredNotificationsById).toHaveBeenCalledWith({
      ids: expect.arrayContaining([id]),
    })
  })

  it('serializes a restore against removal so stale work cannot re-enable it', async () => {
    let finishPendingRead: (
      value: { notifications: never[] },
    ) => void = () => undefined
    reminderMocks.getPending.mockReturnValue(new Promise((resolve) => {
      finishPendingRead = resolve
    }))

    const restoring = restoreEventReminders([event], 'user_a')
    await vi.waitFor(() => expect(reminderMocks.getPending).toHaveBeenCalled())
    const removing = cancelEventReminder(event.id, 'user_a')
    finishPendingRead({ notifications: [] })
    await restoring
    const cancellation = await removing

    expect(cancellation.cleared).toBe(true)
    expect(readDesiredEventReminders('user_a')).toEqual([])
    expect(reminderMocks.schedule).toHaveBeenCalledTimes(1)
    expect(reminderMocks.cancel.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      reminderMocks.schedule.mock.invocationCallOrder.at(-1) ?? 0,
    )

    await reconcileEventReminders('user_a')
    expect(reminderMocks.schedule).toHaveBeenCalledTimes(1)
  })

  it('persists a failed removal for a no-prompt cleanup retry', async () => {
    await enableEventReminder(event, 'user_a')
    reminderMocks.cancel.mockRejectedValueOnce(new Error('native unavailable'))
    reminderMocks.removeDeliveredNotificationsById.mockRejectedValueOnce(
      new Error('native unavailable'),
    )

    const cancellation = await cancelEventReminder(event.id, 'user_a')

    expect(cancellation.cleared).toBe(false)
    expect(cancellation.message).toMatch(/cleanup will retry/i)
    expect(readDesiredEventReminders('user_a')).toEqual([])

    await reconcileEventReminders('user_a')
    expect(reminderMocks.requestPermissions).not.toHaveBeenCalled()
    expect(reminderMocks.cancel).toHaveBeenCalledTimes(3)
  })

  it('cleans an outgoing account without deleting its durable choices', async () => {
    await enableEventReminder(event, 'user_a')
    reminderMocks.getAll.mockResolvedValue({ notifications: [] })

    const cleared = await cleanupEventReminderAccount('user_a')

    expect(cleared).toBe(true)
    expect(readDesiredEventReminders('user_a')).toEqual([event])
    expect(reminderMocks.removeDeliveredNotificationsById).toHaveBeenCalledWith({
      ids: expect.arrayContaining([
        eventReminderNotificationId(event.id, 'user_a'),
      ]),
    })
  })

  it('cleans legacy ID-only selections on sign-out without mounting EventsPage', async () => {
    await transitionEventReminderAccount('legacy_user')
    vi.clearAllMocks()
    reminderMocks.getAll.mockResolvedValue({ notifications: [] })
    const legacyKey = 'kinsphere-event-reminders:legacy_user'
    localStorage.setItem(legacyKey, JSON.stringify([event.id]))

    await transitionEventReminderAccount(null)

    const id = eventReminderNotificationId(event.id, 'legacy_user')
    expect(reminderMocks.cancel).toHaveBeenCalledWith({
      notifications: expect.arrayContaining([{ id }]),
    })
    expect(reminderMocks.removeDeliveredNotificationsById).toHaveBeenCalledWith({
      ids: expect.arrayContaining([id]),
    })
    expect(localStorage.getItem(legacyKey)).toBeNull()
  })
})

describe('browser event reminders', () => {
  it('states that a browser reminder only works while the tab stays open', async () => {
    reminderMocks.native = false
    const BrowserNotification = vi.fn()
    Object.assign(BrowserNotification, {
      permission: 'granted',
      requestPermission: vi.fn(),
    })
    vi.stubGlobal('Notification', BrowserNotification)

    const result = await enableEventReminder(event, 'user_a')

    expect(result.mode).toBe('browser')
    expect(result.message).toMatch(/while this tab stays open/i)
    expect(result.message).toMatch(/closing the tab or browser cancels it/i)
  })
})
