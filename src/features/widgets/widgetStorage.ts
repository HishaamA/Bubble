import { eventStorageKey } from '../events/eventStorage'
import type { PlanTask } from '../events/planDetails'
import type { BubbleWidgetPrivacy, WidgetEvent } from './widgetSnapshot'

export const BUBBLE_WIDGET_DATA_CHANGED_EVENT = 'bubble:widget-data-changed'
export const PLAN_CHECKLISTS_STORAGE_KEY = 'kinsphere-plan-checklists:v1'

const createdEventsStorageKey = 'kinsphere-created-events'
const taskDefinitionsStorageKey = 'kinsphere-plan-tasks:v1'
const completedPlansStorageKey = 'kinsphere-completed-plans:v1'
const viewedRecapsStorageKey = 'bubble-widget-viewed-recaps:v1'
const widgetPrivacyStorageKey = 'bubble-widget-privacy:v1'
const pendingWidgetOptOutStorageKey = 'bubble-widget-pending-opt-out:v1'
const maxStoredIds = 100

/** Reads device-local checklist progress without trusting persisted JSON. */
export function readWidgetChecklistProgress(storageSubject: string) {
  const result: Record<string, string[]> = {}
  const value = readJson(
    eventStorageKey(PLAN_CHECKLISTS_STORAGE_KEY, storageSubject),
  )
  if (!isRecord(value)) return result

  Object.entries(value).forEach(([eventId, taskIds]) => {
    if (!safeId(eventId) || !Array.isArray(taskIds)) return
    const normalized = taskIds
      .filter((taskId): taskId is string => safeId(taskId))
      .slice(0, 100)
    result[eventId] = [...new Set(normalized)]
  })
  return result
}

/** Reads locally-created plans so an offline plan can still reach the widget. */
export function readWidgetLocalEvents(storageSubject: string): WidgetEvent[] {
  const value = readJson(eventStorageKey(createdEventsStorageKey, storageSubject))
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const id = boundedString(item.id, 160)
    const title = boundedString(item.title, 120)
    const startsAt = boundedString(item.startsAt, 80)
    const location = boundedString(item.location, 240) ?? undefined
    const date = startsAt ? new Date(startsAt) : null
    if (!id || !title || !startsAt || !date || Number.isNaN(date.getTime())) {
      return []
    }
    const tasks = readPlanTasks(item.tasks)
    return [{ id, title, startsAt, location, tasks }]
  })
}

/** Reads device-only task edits that have not reached the family service yet. */
export function readWidgetTaskDefinitions(storageSubject: string) {
  const value = readJson(
    eventStorageKey(taskDefinitionsStorageKey, storageSubject),
  )
  const result: Record<string, PlanTask[]> = {}
  if (!isRecord(value)) return result
  Object.entries(value).forEach(([eventId, tasks]) => {
    if (!safeId(eventId) || !Array.isArray(tasks)) return
    result[eventId] = readPlanTasks(tasks)
  })
  return result
}

/** Keeps a locally completed shared plan out of the widget while sync retries. */
export function readWidgetCompletedPlanIds(storageSubject: string) {
  const value = readJson(eventStorageKey(completedPlansStorageKey, storageSubject))
  if (!Array.isArray(value)) return new Set<string>()
  return new Set(value.filter((id): id is string => safeId(id)).slice(-100))
}

/** Reads Capsule recap acknowledgements isolated to one account and family. */
export function readViewedWidgetRecaps(storageSubject: string) {
  const value = readJson(eventStorageKey(viewedRecapsStorageKey, storageSubject))
  if (!Array.isArray(value)) return new Set<string>()
  return new Set(value.filter((id): id is string => safeId(id)).slice(-maxStoredIds))
}

/** Marks a recap viewed so ordinary tasks can regain widget priority. */
export function markWidgetRecapViewed(storageSubject: string, capsuleId: string) {
  if (!safeId(capsuleId)) return false
  const viewed = readViewedWidgetRecaps(storageSubject)
  viewed.delete(capsuleId)
  viewed.add(capsuleId)
  const values = [...viewed].slice(-maxStoredIds)
  const saved = writeJson(
    eventStorageKey(viewedRecapsStorageKey, storageSubject),
    values,
  )
  if (saved) notifyWidgetDataChanged()
  return saved
}

/** Keeps homescreen details private until a member explicitly enables previews. */
export function readWidgetPrivacy(storageSubject: string): BubbleWidgetPrivacy {
  if (typeof window === 'undefined') return 'hidden'
  try {
    if (readPendingWidgetOptOut(storageSubject) !== null) return 'hidden'
    return window.localStorage.getItem(
      eventStorageKey(widgetPrivacyStorageKey, storageSubject),
    ) === 'full'
      ? 'full'
      : 'hidden'
  } catch {
    return 'hidden'
  }
}

/** Applies the saved account preference to this account-and-family partition. */
export function writeWidgetPrivacy(
  storageSubject: string,
  privacy: BubbleWidgetPrivacy,
) {
  if (typeof window === 'undefined') return false
  try {
    const key = eventStorageKey(widgetPrivacyStorageKey, storageSubject)
    const effectivePrivacy = readPendingWidgetOptOut(storageSubject) !== null ? 'hidden' : privacy
    if (window.localStorage.getItem(key) === effectivePrivacy) return true
    window.localStorage.setItem(key, effectivePrivacy)
    notifyWidgetDataChanged()
    return true
  } catch {
    return false
  }
}

/** An unsynced opt-out overrides server hydration for only this account/family. */
export function readPendingWidgetOptOut(storageSubject: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(eventStorageKey(pendingWidgetOptOutStorageKey, storageSubject))
  } catch {
    // Unreadable privacy state must not permit a reveal.
    return 'unavailable'
  }
}

/** Records an explicit choice, retaining opt-out protection until confirmation. */
export function beginWidgetPrivacyChange(storageSubject: string, privacy: BubbleWidgetPrivacy): string | null {
  if (typeof window === 'undefined') return null
  const pending = readPendingWidgetOptOut(storageSubject)
  if (privacy === 'full' && pending === null) return null
  try {
    // Refresh the token even for a newer opt-in. An older row/request must not
    // clear protection created by a later choice after navigating away/back.
    const token = window.crypto.randomUUID()
    window.localStorage.setItem(eventStorageKey(pendingWidgetOptOutStorageKey, storageSubject), token)
    writeWidgetPrivacy(storageSubject, 'hidden')
    return token
  } catch {
    writeWidgetPrivacy(storageSubject, 'hidden')
    return pending
  }
}

/** Only the latest explicitly confirmed choice may clear local protection. */
export function confirmWidgetPrivacyChange(
  storageSubject: string,
  privacy: BubbleWidgetPrivacy,
  pendingToken: string | null,
) {
  if (typeof window === 'undefined') return false
  try {
    if (readPendingWidgetOptOut(storageSubject) !== pendingToken) return false
    window.localStorage.removeItem(eventStorageKey(pendingWidgetOptOutStorageKey, storageSubject))
    return writeWidgetPrivacy(storageSubject, privacy)
  } catch {
    return false
  }
}

/** Notifies the native publisher after same-window local storage changes. */
export function notifyWidgetDataChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(BUBBLE_WIDGET_DATA_CHANGED_EVENT))
  }
}

function readJson(key: string): unknown {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(key)
    return stored ? JSON.parse(stored) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function safeId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 160
}

function boundedString(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= maxLength ? normalized : null
}

function readPlanTasks(value: unknown): PlanTask[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const id = boundedString(item.id, 160)
    const label = boundedString(item.label, 80)
    if (!id || !label || ids.has(id)) return []
    ids.add(id)
    return [{ id, label }]
  }).slice(0, 12)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
