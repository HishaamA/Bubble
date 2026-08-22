import { Capacitor } from '@capacitor/core'
import {
  LocalNotifications,
  type LocalNotificationSchema,
} from '@capacitor/local-notifications'
import {
  flightArrivalTime,
  flightDepartureTime,
  isFlightComplete,
} from './flightValidation'
import {
  clearActiveFlightStorageSubject,
  readActiveFlightStorageSubject,
  readTrackedFlights,
  writeTrackedFlights,
} from './flightStorage'
import type { TrackedFlight } from './types'

export type FlightNotificationResult = {
  enabled: boolean
  mode: 'native' | 'browser' | 'in-app'
  message: string
}

const browserTimers = new Map<number, number>()
const maximumBrowserDelay = 2_147_000_000
const maximumNotificationId = 2_147_483_647
const departureLead = 3 * 60 * 60 * 1000
const arrivalLead = 30 * 60 * 1000

function hashText(value: string) {
  let hash = 2_166_136_261
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

export function flightNotificationIds(flightId: string, accountId: string) {
  return ['departure', 'arrival'].map(
    (kind) => hashText(`${accountId}\u0000${flightId}\u0000${kind}`)
      % (maximumNotificationId - 1) + 1,
  ) as [number, number]
}

function notificationTargets(
  flight: TrackedFlight,
  accountId: string,
  now = new Date(),
) {
  const [departureId, arrivalId] = flightNotificationIds(
    flight.id,
    accountId,
  )
  const departure = flightDepartureTime(flight.snapshot)
  const arrival = flightArrivalTime(flight.snapshot)
  const targets: Array<{ id: number; at: Date; body: string; kind: string }> = []

  if (isFlightComplete(flight.snapshot)) return targets

  if (departure) {
    const at = new Date(new Date(departure).getTime() - departureLead)
    if (at.getTime() > now.getTime()) {
      targets.push({
        id: departureId,
        at,
        kind: 'departure',
        body: 'A tracked family flight departs in about three hours. Open Bubble for details.',
      })
    }
  }
  if (arrival) {
    const at = new Date(new Date(arrival).getTime() - arrivalLead)
    if (at.getTime() > now.getTime()) {
      targets.push({
        id: arrivalId,
        at,
        kind: 'arrival',
        body: 'A tracked family flight is due to arrive in about 30 minutes. Open Bubble for details.',
      })
    }
  }
  return targets
}

function canUseNativeNotifications() {
  return Capacitor.isNativePlatform()
    && Capacitor.isPluginAvailable('LocalNotifications')
}

function nativeNotification(
  target: ReturnType<typeof notificationTargets>[number],
  flight: TrackedFlight,
  accountId: string,
): LocalNotificationSchema {
  return {
    id: target.id,
    title: 'Family flight update',
    body: target.body,
    sound: 'default',
    schedule: { at: target.at, allowWhileIdle: true },
    autoCancel: true,
    group: 'family-flights',
    threadIdentifier: 'family-flights',
    isExactNotification: false,
    isExactMandatory: false,
    extra: {
      kind: `family-flight-${target.kind}`,
      flightId: flight.id,
      accountTag: hashText(accountId).toString(36),
    },
  }
}

export async function enableFlightNotifications(
  flight: TrackedFlight,
  accountId: string,
): Promise<FlightNotificationResult> {
  const targets = notificationTargets(flight, accountId)
  if (targets.length === 0) {
    await cancelFlightNotifications(flight.id, accountId)
    return {
      enabled: false,
      mode: 'in-app',
      message: 'This flight is too close or already complete, so there is no future alert to schedule.',
    }
  }

  if (canUseNativeNotifications()) {
    try {
      let permission = (await LocalNotifications.checkPermissions()).display
      if (permission === 'prompt' || permission === 'prompt-with-rationale') {
        permission = (await LocalNotifications.requestPermissions()).display
      }
      if (permission !== 'granted') {
        return {
          enabled: false,
          mode: 'in-app',
          message: 'Allow notifications in your phone Settings to receive flight alerts.',
        }
      }
      await cancelFlightNotifications(flight.id, accountId)
      await LocalNotifications.schedule({
        notifications: targets.map((target) =>
          nativeNotification(target, flight, accountId),
        ),
      })
      return {
        enabled: true,
        mode: 'native',
        message: `${targets.length === 1 ? 'Flight alert' : 'Departure and arrival alerts'} set on this phone.`,
      }
    } catch {
      return {
        enabled: false,
        mode: 'in-app',
        message: 'Phone alerts are unavailable right now. The flight is still saved in Journal.',
      }
    }
  }

  if (typeof Notification === 'undefined') {
    return {
      enabled: false,
      mode: 'in-app',
      message: 'This browser cannot send flight alerts. The installed iPhone or Android app can.',
    }
  }
  try {
    const permission = Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission
    if (permission !== 'granted') {
      return {
        enabled: false,
        mode: 'in-app',
        message: 'Allow browser notifications to receive alerts while this tab stays open.',
      }
    }
    await cancelFlightNotifications(flight.id, accountId)
    for (const target of targets) {
      const delay = target.at.getTime() - Date.now()
      if (delay <= 0 || delay > maximumBrowserDelay) continue
      browserTimers.set(target.id, window.setTimeout(() => {
        try {
          new Notification('Family flight update', { body: target.body })
        } catch {
          // The durable flight remains even if the browser drops this timer.
        }
        browserTimers.delete(target.id)
      }, delay))
    }
    if (![...flightNotificationIds(flight.id, accountId)].some((id) => browserTimers.has(id))) {
      return {
        enabled: false,
        mode: 'in-app',
        message: 'The flight is saved, but this browser cannot keep an alert that far ahead.',
      }
    }
    return {
      enabled: true,
      mode: 'browser',
      message: 'Browser alerts are set while this tab stays open. Use the installed app for reliable alerts.',
    }
  } catch {
    return {
      enabled: false,
      mode: 'in-app',
      message: 'Browser notifications are unavailable. The flight is still saved in Journal.',
    }
  }
}

/** Replaces existing alerts after a trusted ETA/status refresh, without prompting. */
export async function rescheduleFlightNotifications(
  flight: TrackedFlight,
  accountId: string,
) {
  const targets = notificationTargets(flight, accountId)
  await cancelFlightNotifications(flight.id, accountId)
  if (targets.length === 0) return false

  if (canUseNativeNotifications()) {
    try {
      if ((await LocalNotifications.checkPermissions()).display !== 'granted') {
        return false
      }
      await LocalNotifications.schedule({
        notifications: targets.map((target) =>
          nativeNotification(target, flight, accountId),
        ),
      })
      return true
    } catch {
      return false
    }
  }

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return false
  }
  let scheduled = false
  for (const target of targets) {
    const delay = target.at.getTime() - Date.now()
    if (delay <= 0 || delay > maximumBrowserDelay) continue
    scheduled = true
    browserTimers.set(target.id, window.setTimeout(() => {
      try {
        new Notification('Family flight update', { body: target.body })
      } catch {
        // Browser timers are explicitly best-effort.
      }
      browserTimers.delete(target.id)
    }, delay))
  }
  return scheduled
}

export async function cancelFlightNotifications(
  flightId: string,
  accountId: string,
) {
  const ids = flightNotificationIds(flightId, accountId)
  for (const id of ids) {
    const timer = browserTimers.get(id)
    if (timer !== undefined) window.clearTimeout(timer)
    browserTimers.delete(id)
  }
  if (!canUseNativeNotifications()) return
  await Promise.allSettled([
    LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) }),
    LocalNotifications.removeDeliveredNotificationsById({ ids }),
  ])
}

/** Clears scheduled and already-delivered alerts before an account signs out. */
export async function cancelActiveSubjectFlightNotifications() {
  const subject = readActiveFlightStorageSubject()
  if (!subject) return
  const flights = readTrackedFlights(subject)
  await Promise.allSettled(flights.map((flight) =>
    cancelFlightNotifications(flight.id, subject),
  ))
  writeTrackedFlights(subject, flights.map((flight) => ({
    ...flight,
    notificationEnabled: false,
  })))
  clearActiveFlightStorageSubject()
}
