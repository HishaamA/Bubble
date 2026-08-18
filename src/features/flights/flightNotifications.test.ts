import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackedFlight } from './types'

const notificationApi = vi.hoisted(() => ({
  native: true,
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
  removeDeliveredNotificationsById: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => notificationApi.native,
    isPluginAvailable: () => true,
  },
}))
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: notificationApi.checkPermissions,
    requestPermissions: notificationApi.requestPermissions,
    schedule: notificationApi.schedule,
    cancel: notificationApi.cancel,
    removeDeliveredNotificationsById: notificationApi.removeDeliveredNotificationsById,
  },
}))

import {
  cancelActiveSubjectFlightNotifications,
  enableFlightNotifications,
  flightNotificationIds,
  rescheduleFlightNotifications,
} from './flightNotifications'
import {
  readActiveFlightStorageSubject,
  readTrackedFlights,
  writeActiveFlightStorageSubject,
  writeTrackedFlights,
} from './flightStorage'

const flight: TrackedFlight = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  travelerName: 'Sara',
  flightNumber: 'EK202',
  travelDate: '2099-09-10',
  createdAt: '2026-08-29T12:00:00.000Z',
  notificationEnabled: false,
  synced: false,
  snapshot: {
    provider: 'flightaware',
    providerFlightId: 'UAE202-1',
    flightNumber: 'EK202',
    status: 'Scheduled',
    dataQuality: 'scheduled',
    origin: { code: 'JFK', name: null, city: null, latitude: 40.6, longitude: -73.7, timeZone: 'America/New_York' },
    destination: { code: 'DXB', name: null, city: null, latitude: 25.2, longitude: 55.3, timeZone: 'Asia/Dubai' },
    scheduledDeparture: '2099-09-10T10:00:00.000Z',
    estimatedDeparture: null,
    actualDeparture: null,
    scheduledArrival: '2099-09-10T20:00:00.000Z',
    estimatedArrival: null,
    actualArrival: null,
    progressPercent: 0,
    position: null,
    updatedAt: '2026-08-29T12:00:00.000Z',
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  notificationApi.native = true
  notificationApi.checkPermissions.mockResolvedValue({ display: 'prompt' })
  notificationApi.requestPermissions.mockResolvedValue({ display: 'granted' })
  notificationApi.schedule.mockResolvedValue({ notifications: [] })
  notificationApi.cancel.mockResolvedValue(undefined)
  notificationApi.removeDeliveredNotificationsById.mockResolvedValue(undefined)
})

describe('flight notifications', () => {
  it('uses stable account-and-family-scoped Android-safe IDs', () => {
    const first = flightNotificationIds(flight.id, 'user_A:family:family_A')
    expect(flightNotificationIds(flight.id, 'user_A:family:family_A')).toEqual(first)
    expect(flightNotificationIds(flight.id, 'user_A:family:family_B')).not.toEqual(first)
    expect(new Set(first).size).toBe(2)
    for (const id of first) {
      expect(id).toBeGreaterThan(0)
      expect(id).toBeLessThanOrEqual(2_147_483_647)
    }
  })

  it('asks from the opt-in action and schedules private departure and arrival alerts', async () => {
    const result = await enableFlightNotifications(flight, 'user_A')

    expect(notificationApi.requestPermissions).toHaveBeenCalledTimes(1)
    expect(notificationApi.schedule).toHaveBeenCalledTimes(1)
    const notifications = notificationApi.schedule.mock.calls[0][0].notifications
    expect(notifications).toHaveLength(2)
    expect(notifications[0].body).not.toContain('Sara')
    expect(notifications[0].body).not.toContain('EK202')
    expect(result).toMatchObject({ enabled: true, mode: 'native' })
  })

  it('keeps alerts off when permission is denied', async () => {
    notificationApi.checkPermissions.mockResolvedValue({ display: 'denied' })
    const result = await enableFlightNotifications(flight, 'user_A')
    expect(notificationApi.schedule).not.toHaveBeenCalled()
    expect(result.enabled).toBe(false)
    expect(result.message).toMatch(/phone Settings/i)
  })

  it('replaces existing alerts after a refreshed ETA without prompting again', async () => {
    notificationApi.checkPermissions.mockResolvedValue({ display: 'granted' })
    const result = await rescheduleFlightNotifications({
      ...flight,
      snapshot: {
        ...flight.snapshot,
        estimatedArrival: '2099-09-10T21:15:00.000Z',
      },
    }, 'user_A')

    expect(notificationApi.requestPermissions).not.toHaveBeenCalled()
    expect(notificationApi.cancel).toHaveBeenCalledTimes(1)
    expect(notificationApi.schedule).toHaveBeenCalledTimes(1)
    expect(result).toBe(true)
  })

  it('cancels alerts after arrival or cancellation', async () => {
    notificationApi.checkPermissions.mockResolvedValue({ display: 'granted' })
    const result = await rescheduleFlightNotifications({
      ...flight,
      snapshot: { ...flight.snapshot, status: 'Cancelled' },
    }, 'user_A')

    expect(notificationApi.cancel).toHaveBeenCalledTimes(1)
    expect(notificationApi.removeDeliveredNotificationsById).toHaveBeenCalledTimes(1)
    expect(notificationApi.schedule).not.toHaveBeenCalled()
    expect(result).toBe(false)
  })

  it('keeps alerts scheduled for an uncertain cancellation', async () => {
    notificationApi.checkPermissions.mockResolvedValue({ display: 'granted' })
    const result = await rescheduleFlightNotifications({
      ...flight,
      snapshot: { ...flight.snapshot, status: 'Possibly cancelled' },
    }, 'user_A')

    expect(notificationApi.schedule).toHaveBeenCalledTimes(1)
    expect(result).toBe(true)
  })

  it('cancels pending and delivered alarms for the active subject on sign-out', async () => {
    const subject = 'user_A:family:family_A'
    writeTrackedFlights(subject, [{ ...flight, notificationEnabled: true }])
    writeActiveFlightStorageSubject(subject)

    await cancelActiveSubjectFlightNotifications()

    expect(notificationApi.cancel).toHaveBeenCalledTimes(1)
    expect(notificationApi.removeDeliveredNotificationsById).toHaveBeenCalledTimes(1)
    expect(readTrackedFlights(subject)[0].notificationEnabled).toBe(false)
    expect(readActiveFlightStorageSubject()).toBeNull()
  })
})
