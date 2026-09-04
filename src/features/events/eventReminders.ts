import { Capacitor } from '@capacitor/core'
import {
  LocalNotifications,
  type LocalNotificationSchema,
  type PendingLocalNotificationSchema,
} from '@capacitor/local-notifications'

export type ReminderEvent = {
  id: string
  title: string
  startsAt: string
}

export type ReminderResult = {
  mode: 'native' | 'browser' | 'in-app'
  message: string
}

export type ReminderCancellationResult = {
  cleared: boolean
  message: string
}

type ReminderRegistry = {
  schema: 1
  revision: number
  desired: ReminderEvent[]
  managedEventIds: string[]
}

const browserTimers = new Map<string, number>()
const memoryRegistries = new Map<string, ReminderRegistry>()
const accountQueues = new Map<string, Promise<void>>()
const accountEpochs = new Map<string, number>()
let accountTransitionQueue: Promise<void> = Promise.resolve()

const maximumBrowserDelay = 2_147_000_000
const maximumNotificationId = 2_147_483_647
const notificationGroup = 'family-events'
const notificationKind = 'family-event-reminder'
const privateNotificationTitle = 'Family time soon'
const privateNotificationBody =
  'A family event starts in one hour. Open Bubble for the details.'
const registryKeyPrefix = 'kinsphere-event-reminder-registry:v1:'
const legacyReminderIdsKey = 'kinsphere-event-reminders'
const activeAccountKey = 'kinsphere-event-reminder-active-account:v1'
const pendingCleanupKey = 'kinsphere-event-reminder-pending-cleanup:v1'

export const reminderLeadTime = 60 * 60 * 1000

/** Converts an event start into its one-hour-before alert timestamp. */
function reminderTime(startsAt: string) {
  return new Date(startsAt).getTime() - reminderLeadTime
}

/** Delimits account and event IDs so browser timers cannot collide. */
function timerKey(eventId: string, accountNamespace: string) {
  return `${accountNamespace}\u0000${eventId}`
}

/** Identifies every browser timer owned by one account namespace. */
function timerPrefix(accountNamespace: string) {
  return `${accountNamespace}\u0000`
}

/** Computes the deterministic unsigned hash used by native notification IDs. */
function hashText(input: string) {
  let hash = 2_166_136_261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

/** Stable, account-scoped ID that always fits Android's signed 32-bit range. */
export function eventReminderNotificationId(
  eventId: string,
  accountNamespace = 'signed-out',
) {
  return hashText(timerKey(eventId, accountNamespace))
    % (maximumNotificationId - 1) + 1
}

/** Produces a privacy-preserving tag for discovering one account's alerts. */
function notificationAccountTag(accountNamespace: string) {
  return hashText(`account\u0000${accountNamespace}`).toString(36)
}

/** Recreates IDs used before reminders became account-scoped. */
function legacyNotificationId(eventId: string) {
  let hash = 0
  for (const character of eventId) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0
  }
  const id = Math.abs(hash || 1)
  return id <= maximumNotificationId ? id : null
}

/** Returns current and legacy IDs so upgrades can cancel both safely. */
function notificationIds(eventId: string, accountNamespace: string) {
  const current = eventReminderNotificationId(eventId, accountNamespace)
  const legacy = legacyNotificationId(eventId)
  return legacy !== null && legacy !== current ? [current, legacy] : [current]
}

/** Checks both the runtime and plugin before calling native notification APIs. */
function canUseNativeNotifications() {
  return Capacitor.isNativePlatform()
    && Capacitor.isPluginAvailable('LocalNotifications')
}

/** Encodes the account namespace into its durable reminder registry key. */
function registryStorageKey(accountNamespace: string) {
  return `${registryKeyPrefix}${encodeURIComponent(accountNamespace)}`
}

/** Locates the ID-only registry used by pre-v1 reminder storage. */
function legacyReminderStorageKey(accountNamespace: string) {
  return `${legacyReminderIdsKey}:${encodeURIComponent(
    accountNamespace.trim() || 'signed-out',
  )}`
}

/** Reads valid IDs from legacy storage without making startup depend on it. */
function readLegacyReminderIds(accountNamespace: string) {
  try {
    const value = JSON.parse(
      localStorage.getItem(legacyReminderStorageKey(accountNamespace)) ?? '[]',
    )
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/** Removes migrated legacy state and reports whether persistence succeeded. */
function removeLegacyReminderIds(accountNamespace: string) {
  try {
    localStorage.removeItem(legacyReminderStorageKey(accountNamespace))
    return true
  } catch {
    return false
  }
}

/** Creates the initial durable reminder registry. */
function emptyRegistry(): ReminderRegistry {
  return { schema: 1, revision: 0, desired: [], managedEventIds: [] }
}

/** Validates the minimal event snapshot needed to rebuild an alert. */
function isReminderEvent(value: unknown): value is ReminderEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<ReminderEvent>
  return typeof event.id === 'string'
    && typeof event.title === 'string'
    && typeof event.startsAt === 'string'
}

/** Parses persisted state while dropping malformed events and managed IDs. */
function parseRegistry(value: string | null): ReminderRegistry | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<ReminderRegistry>
    if (
      parsed.schema !== 1
      || typeof parsed.revision !== 'number'
      || !Array.isArray(parsed.desired)
      || !Array.isArray(parsed.managedEventIds)
    ) return null

    return {
      schema: 1,
      revision: parsed.revision,
      desired: parsed.desired.filter(isReminderEvent),
      managedEventIds: parsed.managedEventIds.filter(
        (id): id is string => typeof id === 'string',
      ),
    }
  } catch {
    return null
  }
}

/** Reads durable state, falling back to an account-isolated memory registry. */
function readRegistry(accountNamespace: string) {
  const key = registryStorageKey(accountNamespace)
  try {
    const stored = parseRegistry(localStorage.getItem(key))
    if (stored) return stored
  } catch {
    // Fall through to the in-memory registry when private storage is unavailable.
  }
  return memoryRegistries.get(key) ?? emptyRegistry()
}

/** Persists a registry or retains it in memory when web storage is unavailable. */
function writeRegistry(accountNamespace: string, registry: ReminderRegistry) {
  const key = registryStorageKey(accountNamespace)
  try {
    localStorage.setItem(key, JSON.stringify(registry))
    memoryRegistries.delete(key)
  } catch {
    memoryRegistries.set(key, registry)
  }
}

/** Advances the registry revision and de-duplicates both desired and managed sets. */
function nextRegistry(
  registry: ReminderRegistry,
  patch: Pick<ReminderRegistry, 'desired' | 'managedEventIds'>,
): ReminderRegistry {
  return {
    schema: 1,
    revision: registry.revision + 1,
    desired: [...new Map(patch.desired.map((event) => [event.id, event])).values()],
    managedEventIds: [...new Set(patch.managedEventIds)],
  }
}

/** Reads the validated, account-scoped reminder intent registry. */
export function readDesiredEventReminders(accountNamespace: string) {
  return readRegistry(accountNamespace).desired
}

/** Serializes side effects per account so schedule and cleanup cannot interleave. */
function serializeAccountOperation<T>(
  accountNamespace: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = accountQueues.get(accountNamespace) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const settled = result.then(() => undefined, () => undefined)
  accountQueues.set(accountNamespace, settled)
  void settled.finally(() => {
    if (accountQueues.get(accountNamespace) === settled) {
      accountQueues.delete(accountNamespace)
    }
  })
  return result
}

/** Returns the cancellation generation for in-flight account work. */
function accountEpoch(accountNamespace: string) {
  return accountEpochs.get(accountNamespace) ?? 0
}

/** Invalidates permission work started before an account cleanup. */
function invalidateAccountOperations(accountNamespace: string) {
  accountEpochs.set(accountNamespace, accountEpoch(accountNamespace) + 1)
}

/** Builds a private, restorable native notification payload for one event. */
function notificationFor(
  event: ReminderEvent,
  accountNamespace: string,
  isExactNotification: boolean,
): LocalNotificationSchema {
  return {
    id: eventReminderNotificationId(event.id, accountNamespace),
    title: privateNotificationTitle,
    body: privateNotificationBody,
    sound: 'default',
    schedule: {
      at: new Date(reminderTime(event.startsAt)),
      allowWhileIdle: true,
    },
    autoCancel: true,
    group: notificationGroup,
    threadIdentifier: notificationGroup,
    isExactNotification,
    isExactMandatory: false,
    extra: {
      kind: notificationKind,
      accountTag: notificationAccountTag(accountNamespace),
      eventId: event.id,
      startsAt: event.startsAt,
    },
  }
}

/** Clears pending and delivered copies of deterministic notification IDs. */
async function clearNativeIds(ids: number[]) {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return true
  const [pending, delivered] = await Promise.allSettled([
    LocalNotifications.cancel({
      notifications: uniqueIds.map((id) => ({ id })),
    }),
    LocalNotifications.removeDeliveredNotificationsById({ ids: uniqueIds }),
  ])
  return pending.status === 'fulfilled' && delivered.status === 'fulfilled'
}

/** Cancels one browser timer and releases its in-memory ownership entry. */
function clearBrowserTimer(eventId: string, accountNamespace: string) {
  const key = timerKey(eventId, accountNamespace)
  const timer = browserTimers.get(key)
  if (timer === undefined) return
  window.clearTimeout(timer)
  browserTimers.delete(key)
}

/** Cancels every browser timer owned by an account during transition cleanup. */
function clearBrowserAccount(accountNamespace: string) {
  const prefix = timerPrefix(accountNamespace)
  for (const [key, timer] of browserTimers) {
    if (!key.startsWith(prefix)) continue
    window.clearTimeout(timer)
    browserTimers.delete(key)
  }
}

/** Schedules a best-effort, tab-lifetime browser alert when timing permits. */
function scheduleBrowserReminder(
  event: ReminderEvent,
  accountNamespace: string,
): ReminderResult {
  if (typeof Notification === 'undefined') {
    return {
      mode: 'in-app',
      message:
        'Reminder saved in Journal. This browser cannot deliver phone notifications.',
    }
  }

  const delay = reminderTime(event.startsAt) - Date.now()
  if (Notification.permission !== 'granted') {
    return {
      mode: 'in-app',
      message:
        'Saved in Journal. Allow notifications in browser settings for an alert while this tab stays open.',
    }
  }

  if (!Number.isFinite(delay) || delay <= 0) {
    return {
      mode: 'in-app',
      message: 'Saved in Journal. This event is too close for a one-hour alert.',
    }
  }

  if (delay > maximumBrowserDelay) {
    return {
      mode: 'in-app',
      message:
        'Saved in Journal. A browser cannot deliver this after the tab closes; reopen it closer to the event.',
    }
  }

  clearBrowserTimer(event.id, accountNamespace)
  const key = timerKey(event.id, accountNamespace)
  const timer = window.setTimeout(() => {
    try {
      new Notification(privateNotificationTitle, {
        body: privateNotificationBody,
      })
    } catch {
      // The durable selection remains if the browser rejects the alert.
    }
    browserTimers.delete(key)
  }, delay)
  browserTimers.set(key, timer)

  return {
    mode: 'browser',
    message:
      'Browser reminder set while this tab stays open. Closing the tab or browser cancels it.',
  }
}

type PreparedPermission =
  | 'native-granted'
  | 'native-denied'
  | 'native-unavailable'
  | 'browser-granted'
  | 'browser-denied'
  | 'browser-unavailable'

/** Requests notification permission only from the direct user-enable path. */
async function preparePermissionFromUser(): Promise<PreparedPermission> {
  if (canUseNativeNotifications()) {
    try {
      let permission = (await LocalNotifications.checkPermissions()).display
      if (permission === 'prompt' || permission === 'prompt-with-rationale') {
        permission = (await LocalNotifications.requestPermissions()).display
      }
      return permission === 'granted' ? 'native-granted' : 'native-denied'
    } catch {
      return 'native-unavailable'
    }
  }

  if (typeof Notification === 'undefined') return 'browser-unavailable'
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      return 'browser-unavailable'
    }
  }
  return Notification.permission === 'granted'
    ? 'browser-granted'
    : 'browser-denied'
}

/** Call only as the direct result of a user action. */
export async function enableEventReminder(
  event: ReminderEvent,
  accountNamespace = 'signed-out',
): Promise<ReminderResult> {
  const startedInEpoch = accountEpoch(accountNamespace)
  const at = reminderTime(event.startsAt)
  const permission = Number.isFinite(at) && at > Date.now()
    ? await preparePermissionFromUser()
    : 'browser-unavailable'

  return serializeAccountOperation(accountNamespace, async () => {
    const registry = readRegistry(accountNamespace)
    const desired = registry.desired.filter((item) => item.id !== event.id)
    desired.push(event)
    const updated = nextRegistry(registry, {
      desired,
      managedEventIds: [...registry.managedEventIds, event.id],
    })
    writeRegistry(accountNamespace, updated)

    if (!Number.isFinite(at) || at <= Date.now()) {
      return {
        mode: 'in-app',
        message: 'Saved in Journal. This event is too close for a one-hour alert.',
      }
    }

    if (startedInEpoch !== accountEpoch(accountNamespace)) {
      return {
        mode: 'in-app',
        message:
          'Reminder saved for this account. Reopen it to finish setting the phone alert.',
      }
    }

    if (permission === 'native-denied') {
      return {
        mode: 'in-app',
        message:
          'Saved in Journal. Allow notifications in your phone Settings for a background alert.',
      }
    }
    if (permission === 'native-unavailable') {
      return {
        mode: 'in-app',
        message: 'Saved in Journal. Phone notifications are unavailable right now.',
      }
    }
    if (permission === 'browser-denied') {
      return {
        mode: 'in-app',
        message:
          'Saved in Journal. Allow notifications in browser settings for an alert while this tab stays open.',
      }
    }
    if (permission === 'browser-unavailable') {
      return {
        mode: 'in-app',
        message:
          'Reminder saved in Journal. This browser cannot deliver phone notifications.',
      }
    }
    if (permission === 'browser-granted') {
      return scheduleBrowserReminder(event, accountNamespace)
    }

    await clearNativeIds(notificationIds(event.id, accountNamespace))
    try {
      const result = await LocalNotifications.schedule({
        notifications: [notificationFor(event, accountNamespace, true)],
      })
      if (result.warning) {
        return {
          mode: 'native',
          message:
            'Phone reminder set. Android may deliver it near the requested time unless exact alarms are allowed.',
        }
      }
      return {
        mode: 'native',
        message:
          'Phone reminder set for one hour before, including when the installed app is not open.',
      }
    } catch {
      return {
        mode: 'in-app',
        message:
          'Saved in Journal. Phone scheduling failed and will retry when the app resumes.',
      }
    }
  })
}

/** Normalizes Capacitor's flexible schedule value to a comparable timestamp. */
function pendingScheduleTime(notification: PendingLocalNotificationSchema) {
  const at = notification.schedule?.at
  if (!at) return Number.NaN
  return new Date(at as Date | string | number).getTime()
}

/** Reads only the metadata fields used to identify app-owned notifications. */
function pendingExtra(notification: { extra?: unknown }) {
  return notification.extra as
    | {
        kind?: unknown
        accountTag?: unknown
        eventId?: unknown
        startsAt?: unknown
      }
    | undefined
}

/** Verifies that a pending native alert still matches durable event intent. */
function matchesPendingEvent(
  notification: PendingLocalNotificationSchema,
  event: ReminderEvent,
  accountNamespace: string,
) {
  const extra = pendingExtra(notification)
  return extra?.kind === notificationKind
    && (
      extra.accountTag === undefined
      || extra.accountTag === notificationAccountTag(accountNamespace)
    )
    && extra.eventId === event.id
    && extra.startsAt === event.startsAt
    && Math.abs(pendingScheduleTime(notification) - reminderTime(event.startsAt))
      < 1_000
}

/** Checks whether Android can restore exact alarms without prompting the user. */
async function canRestoreExactAndroidReminder() {
  if (Capacitor.getPlatform() !== 'android') return true
  try {
    return (await LocalNotifications.checkExactNotificationSetting()).exact_alarm
      === 'granted'
  } catch {
    return false
  }
}

/** Makes native or browser schedules converge on one account's durable intent. */
async function reconcileRegistry(accountNamespace: string) {
  let registry = readRegistry(accountNamespace)
  const futureDesired = registry.desired.filter(
    (event) => reminderTime(event.startsAt) > Date.now(),
  )
  if (futureDesired.length !== registry.desired.length) {
    registry = nextRegistry(registry, {
      desired: futureDesired,
      managedEventIds: registry.managedEventIds,
    })
    writeRegistry(accountNamespace, registry)
  }

  const desiredById = new Map(registry.desired.map((event) => [event.id, event]))
  const desiredNotificationIds = new Map(
    registry.desired.map((event) => [
      eventReminderNotificationId(event.id, accountNamespace),
      event,
    ]),
  )

  if (!canUseNativeNotifications()) {
    const desiredIds = new Set(desiredById.keys())
    const prefix = timerPrefix(accountNamespace)
    for (const key of [...browserTimers.keys()]) {
      const eventId = key.slice(prefix.length)
      if (key.startsWith(prefix) && !desiredIds.has(eventId)) {
        clearBrowserTimer(eventId, accountNamespace)
      }
    }
    if (
      typeof Notification !== 'undefined'
      && Notification.permission === 'granted'
    ) {
      for (const event of registry.desired) {
        scheduleBrowserReminder(event, accountNamespace)
      }
    }
    return
  }

  let pendingNotifications: PendingLocalNotificationSchema[] = []
  let pendingReadSucceeded = false
  try {
    pendingNotifications = (await LocalNotifications.getPending()).notifications
    pendingReadSucceeded = true
  } catch {
    // Known stale IDs below are still canceled; scheduling waits for a full read.
  }

  const matchingPendingIds = new Set<number>()
  const staleIds = new Set<number>()
  const desiredIds = new Set(desiredById.keys())

  for (const managedEventId of registry.managedEventIds) {
    if (!desiredIds.has(managedEventId)) {
      for (const id of notificationIds(managedEventId, accountNamespace)) {
        staleIds.add(id)
      }
    }
  }

  if (pendingReadSucceeded) {
    const tag = notificationAccountTag(accountNamespace)
    const legacyDesiredIds = new Set(
      registry.desired.flatMap((event) =>
        notificationIds(event.id, accountNamespace).slice(1),
      ),
    )
    for (const notification of pendingNotifications) {
      const extra = pendingExtra(notification)
      const taggedForAccount = extra?.kind === notificationKind
        && extra.accountTag === tag
      const desiredEvent = desiredNotificationIds.get(notification.id)
      if (
        desiredEvent
        && matchesPendingEvent(notification, desiredEvent, accountNamespace)
      ) {
        matchingPendingIds.add(notification.id)
      } else if (
        desiredEvent
        || taggedForAccount
        || legacyDesiredIds.has(notification.id)
        || staleIds.has(notification.id)
      ) {
        staleIds.add(notification.id)
      }
    }
  }

  const staleCleared = await clearNativeIds([...staleIds])
  if (staleCleared) {
    const managedEventIds = registry.managedEventIds.filter((id) =>
      desiredIds.has(id),
    )
    if (managedEventIds.length !== registry.managedEventIds.length) {
      registry = nextRegistry(registry, {
        desired: registry.desired,
        managedEventIds,
      })
      writeRegistry(accountNamespace, registry)
    }
  }

  if (!pendingReadSucceeded) return
  try {
    if ((await LocalNotifications.checkPermissions()).display !== 'granted') {
      return
    }
  } catch {
    return
  }

  const notifications = registry.desired
    .filter((event) =>
      !matchingPendingIds.has(
        eventReminderNotificationId(event.id, accountNamespace),
      ),
    )
  if (notifications.length === 0) return

  const isExactNotification = await canRestoreExactAndroidReminder()
  try {
    await LocalNotifications.schedule({
      notifications: notifications.map((event) =>
        notificationFor(event, accountNamespace, isExactNotification),
      ),
    })
    const latest = readRegistry(accountNamespace)
    writeRegistry(accountNamespace, nextRegistry(latest, {
      desired: latest.desired,
      managedEventIds: [
        ...latest.managedEventIds,
        ...notifications.map((event) => event.id),
      ],
    }))
  } catch {
    // Durable desired state makes this retryable on the next native resume.
  }
}

/** Reconciles the latest durable desired set and never prompts for permission. */
export function reconcileEventReminders(accountNamespace: string) {
  return serializeAccountOperation(accountNamespace, () =>
    reconcileRegistry(accountNamespace),
  )
}

/**
 * Compatibility helper: treats `events` as the complete desired set, versions
 * it durably, then reconciles through the same serialized account queue.
 */
export function restoreEventReminders(
  events: ReminderEvent[],
  accountNamespace = 'signed-out',
) {
  return serializeAccountOperation(accountNamespace, async () => {
    const registry = readRegistry(accountNamespace)
    writeRegistry(accountNamespace, nextRegistry(registry, {
      desired: events,
      managedEventIds: [
        ...registry.managedEventIds,
        ...events.map((event) => event.id),
      ],
    }))
    await reconcileRegistry(accountNamespace)
  })
}

/** Migrates legacy ID-only selections once their event snapshots are available. */
export function adoptDesiredEventReminders(
  events: ReminderEvent[],
  accountNamespace: string,
) {
  if (events.length === 0) return Promise.resolve()
  return serializeAccountOperation(accountNamespace, async () => {
    const registry = readRegistry(accountNamespace)
    const desired = new Map(registry.desired.map((event) => [event.id, event]))
    let changed = false
    for (const event of events) {
      if (!desired.has(event.id)) changed = true
      desired.set(event.id, event)
    }
    if (!changed) return
    writeRegistry(accountNamespace, nextRegistry(registry, {
      desired: [...desired.values()],
      managedEventIds: [
        ...registry.managedEventIds,
        ...events.map((event) => event.id),
      ],
    }))
    await reconcileRegistry(accountNamespace)
  })
}

/** Removes one reminder from durable intent and scheduled notifications. */
export function cancelEventReminder(
  eventId: string,
  accountNamespace = 'signed-out',
): Promise<ReminderCancellationResult> {
  return serializeAccountOperation(accountNamespace, async () => {
    let registry = readRegistry(accountNamespace)
    registry = nextRegistry(registry, {
      desired: registry.desired.filter((event) => event.id !== eventId),
      managedEventIds: [...registry.managedEventIds, eventId],
    })
    writeRegistry(accountNamespace, registry)
    clearBrowserTimer(eventId, accountNamespace)

    if (!canUseNativeNotifications()) {
      writeRegistry(accountNamespace, nextRegistry(registry, {
        desired: registry.desired,
        managedEventIds: registry.managedEventIds.filter((id) => id !== eventId),
      }))
      return {
        cleared: true,
        message: 'Reminder removed.',
      }
    }

    const cleared = await clearNativeIds(
      notificationIds(eventId, accountNamespace),
    )
    if (cleared) {
      writeRegistry(accountNamespace, nextRegistry(registry, {
        desired: registry.desired,
        managedEventIds: registry.managedEventIds.filter((id) => id !== eventId),
      }))
      return {
        cleared: true,
        message: 'Phone reminder removed.',
      }
    }

    return {
      cleared: false,
      message:
        'Reminder turned off in Bubble. Phone alert cleanup will retry when the app resumes.',
    }
  })
}

/** Reads lifecycle metadata without making storage availability a requirement. */
function readString(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Writes optional lifecycle metadata on a best-effort basis. */
function writeString(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Lifecycle state remains best-effort when browser storage is unavailable.
  }
}

/** Loads accounts whose native notification cleanup still needs a retry. */
function readPendingCleanupAccounts() {
  try {
    const value = JSON.parse(localStorage.getItem(pendingCleanupKey) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/** Persists a de-duplicated cleanup retry queue. */
function writePendingCleanupAccounts(accounts: string[]) {
  writeString(pendingCleanupKey, JSON.stringify([...new Set(accounts)]))
}

/** Queues an account before cleanup begins so interruption remains recoverable. */
function addPendingCleanupAccount(accountNamespace: string) {
  writePendingCleanupAccounts([
    ...readPendingCleanupAccounts(),
    accountNamespace,
  ])
}

/** Removes an account only after all known cleanup work succeeds. */
function removePendingCleanupAccount(accountNamespace: string) {
  writePendingCleanupAccounts(
    readPendingCleanupAccounts().filter((account) =>
      account !== accountNamespace,
    ),
  )
}

/** Discovers app-owned native notifications when the registry lacks their IDs. */
async function discoverTaggedNotificationIds(accountNamespace: string) {
  const tag = notificationAccountTag(accountNamespace)
  const { notifications } = await LocalNotifications.getAll()
  return notifications
    .filter((notification) => {
      const extra = pendingExtra(notification)
      return extra?.kind === notificationKind && extra.accountTag === tag
    })
    .map((notification) => notification.id)
}

/** Clears one account's reminder intent, timers, and native notifications. */
export function cleanupEventReminderAccount(accountNamespace: string) {
  invalidateAccountOperations(accountNamespace)
  addPendingCleanupAccount(accountNamespace)
  return serializeAccountOperation(accountNamespace, async () => {
    clearBrowserAccount(accountNamespace)
    const registry = readRegistry(accountNamespace)
    const eventIds = new Set([
      ...registry.managedEventIds,
      ...registry.desired.map((event) => event.id),
      ...readLegacyReminderIds(accountNamespace),
    ])

    if (!canUseNativeNotifications()) {
      writeRegistry(accountNamespace, nextRegistry(registry, {
        desired: registry.desired,
        managedEventIds: [],
      }))
      if (!removeLegacyReminderIds(accountNamespace)) return false
      removePendingCleanupAccount(accountNamespace)
      return true
    }

    const ids = new Set<number>()
    for (const eventId of eventIds) {
      for (const id of notificationIds(eventId, accountNamespace)) ids.add(id)
    }

    let discoverySucceeded = false
    try {
      for (const id of await discoverTaggedNotificationIds(accountNamespace)) {
        ids.add(id)
      }
      discoverySucceeded = true
    } catch {
      // Known IDs are still canceled; discovery is retried on the next resume.
    }

    const cleared = await clearNativeIds([...ids])
    if (!cleared || !discoverySucceeded) return false

    writeRegistry(accountNamespace, nextRegistry(registry, {
      desired: registry.desired,
      managedEventIds: [],
    }))
    if (!removeLegacyReminderIds(accountNamespace)) return false
    removePendingCleanupAccount(accountNamespace)
    return true
  })
}

/** Cleans the outgoing account before restoring alerts for the incoming one. */
async function transitionReminderAccount(nextAccount: string | null) {
  const outgoingAccount = readString(activeAccountKey)
  if (outgoingAccount && outgoingAccount !== nextAccount) {
    await cleanupEventReminderAccount(outgoingAccount)
  }

  writeString(activeAccountKey, nextAccount)
  for (const pendingAccount of readPendingCleanupAccounts()) {
    await cleanupEventReminderAccount(pendingAccount)
  }
  if (nextAccount) await reconcileEventReminders(nextAccount)
}

/** Called by the app-level auth coordinator; never requests permission. */
export function transitionEventReminderAccount(nextAccount: string | null) {
  const result = accountTransitionQueue
    .catch(() => undefined)
    .then(() => transitionReminderAccount(nextAccount))
  accountTransitionQueue = result.then(() => undefined, () => undefined)
  return result
}

/** Called for native foreground/resume events from any route. */
export function resumeEventReminderAccount(accountNamespace: string | null) {
  const result = accountTransitionQueue
    .catch(() => undefined)
    .then(async () => {
      for (const pendingAccount of readPendingCleanupAccounts()) {
        await cleanupEventReminderAccount(pendingAccount)
      }
      if (accountNamespace) await reconcileEventReminders(accountNamespace)
    })
  accountTransitionQueue = result.then(() => undefined, () => undefined)
  return result
}
