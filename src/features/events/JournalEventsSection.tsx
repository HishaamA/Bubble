import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../auth'
import { useFamilyOnboarding } from '../onboarding'
import '../FeaturePages.css'
import './EventsPage.css'
import {
  adoptDesiredEventReminders,
  cancelEventReminder,
  enableEventReminder,
  readDesiredEventReminders,
  type ReminderEvent,
} from './eventReminders'
import {
  createFamilyEvent as createFamilyEventRecord,
  fetchFamilyEvents,
  subscribeToFamilyEvents,
  syncEventReminder,
  type FamilyEventRecord,
} from './eventService'
import {
  eventStorageKey,
  familyEventStorageSubject,
} from './eventStorage'

type FamilyEvent = ReminderEvent & {
  date: string
  time: string
  location: string
  category: PlanCategory
}

const createdEventsKey = 'kinsphere-created-events'
const reminderIdsKey = 'kinsphere-event-reminders'
const categoryDetailsPrefix = 'kinsphere-plan-category:v1:'
const planCategories = [
  { value: 'travel', label: 'Travel' },
  { value: 'graduation', label: 'Graduation' },
  { value: 'wedding', label: 'Wedding' },
  { value: 'anniversary', label: 'Anniversary' },
  { value: 'appointment', label: 'Important appointment' },
  { value: 'other', label: 'Other milestone' },
] as const

type PlanCategory = (typeof planCategories)[number]['value']

/**
 * Family plans embedded in Journal. This component owns the same offline,
 * Realtime, and device-reminder behavior that the former Together page used.
 */
export function JournalEventsSection() {
  const { user } = useAuth()
  const { snapshot } = useFamilyOnboarding()
  const familyId = snapshot?.kind === 'member'
    ? snapshot.membership.familyId
    : null
  const storageSubject = familyEventStorageSubject(user?.id, familyId)

  return (
    <JournalEventsSectionForFamily
      key={storageSubject}
      storageSubject={storageSubject}
    />
  )
}

function JournalEventsSectionForFamily({
  storageSubject,
}: {
  storageSubject: string
}) {
  const upcomingListId = useId()
  const formErrorId = useId()
  const createdEventsStorageKey = eventStorageKey(
    createdEventsKey,
    storageSubject,
  )
  const reminderIdsStorageKey = eventStorageKey(
    reminderIdsKey,
    storageSubject,
  )
  const [isUpcomingExpanded, setIsUpcomingExpanded] = useState(false)
  const [showEventSheet, setShowEventSheet] = useState(false)
  const [eventSaving, setEventSaving] = useState(false)
  const [eventFormError, setEventFormError] = useState('')
  const [timelineOpenedAt] = useState(Date.now)
  const [createdEvents, setCreatedEvents] = useState<FamilyEvent[]>(() =>
    readCreatedEvents(createdEventsStorageKey),
  )
  const [sharedFamilyEvents, setSharedFamilyEvents] = useState<FamilyEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [sharedEventsUnavailable, setSharedEventsUnavailable] = useState(false)
  const [reminderIds, setReminderIds] = useState<Set<string>>(
    () =>
      new Set([
        ...readReminderIds(reminderIdsStorageKey),
        ...readDesiredEventReminders(storageSubject).map((event) => event.id),
      ]),
  )
  const [reminderStatus, setReminderStatus] = useState('')
  const eventSheetRef = useRef<HTMLFormElement>(null)
  const eventSheetFirstFieldRef = useRef<HTMLSelectElement>(null)
  const eventSheetOpenerRef = useRef<HTMLElement | null>(null)

  const allUpcomingEvents = useMemo(() => {
    const eventsById = new Map<string, FamilyEvent>()
    for (const event of [...createdEvents, ...sharedFamilyEvents]) {
      const startsAt = new Date(event.startsAt).getTime()
      if (!Number.isFinite(startsAt) || startsAt < timelineOpenedAt) continue
      eventsById.set(event.id, event)
    }
    return [...eventsById.values()].sort(
      (left, right) =>
        new Date(left.startsAt).getTime() -
        new Date(right.startsAt).getTime(),
    )
  }, [createdEvents, sharedFamilyEvents, timelineOpenedAt])

  const refreshFamilyEvents = useCallback(async () => {
    const records = await fetchFamilyEvents()
    setSharedFamilyEvents(toImportantFamilyEvents(records))
    setSharedEventsUnavailable(false)
  }, [])

  useEffect(() => {
    let active = true
    let unsubscribe: () => void = () => undefined

    async function refreshWhileActive() {
      try {
        const records = await fetchFamilyEvents()
        if (active) {
          setSharedFamilyEvents(toImportantFamilyEvents(records))
          setSharedEventsUnavailable(false)
        }
      } catch {
        if (active) setSharedEventsUnavailable(true)
        // Locally-created plans remain available while offline.
      } finally {
        if (active) setEventsLoading(false)
      }
    }

    void refreshWhileActive()
    void subscribeToFamilyEvents(() => void refreshWhileActive())
      .then((stop) => {
        if (active) unsubscribe = stop
        else stop()
      })
      .catch(() => {
        // Realtime is an enhancement; the local and initial-fetch paths remain.
      })

    return () => {
      active = false
      unsubscribe()
    }
  }, [storageSubject])

  useEffect(() => {
    const selectedEvents = allUpcomingEvents.filter((event) =>
      reminderIds.has(event.id),
    )
    void adoptDesiredEventReminders(selectedEvents, storageSubject)
  }, [allUpcomingEvents, reminderIds, storageSubject])

  useEffect(() => {
    if (!showEventSheet) return
    const frame = window.requestAnimationFrame(() => {
      eventSheetFirstFieldRef.current?.focus()
    })
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function handleModalKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (!eventSaving) {
          setShowEventSheet(false)
          window.requestAnimationFrame(() => {
            eventSheetOpenerRef.current?.focus()
          })
        }
        return
      }
      if (event.key !== 'Tab' || !eventSheetRef.current) return
      const focusable = [...eventSheetRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )]
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleModalKey)
    return () => {
      window.cancelAnimationFrame(frame)
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleModalKey)
    }
  }, [eventSaving, showEventSheet])

  function openEventSheet() {
    eventSheetOpenerRef.current = document.activeElement as HTMLElement | null
    setEventFormError('')
    setShowEventSheet(true)
  }

  function closeEventSheet(force = false) {
    if (eventSaving && !force) return
    setShowEventSheet(false)
    window.requestAnimationFrame(() => eventSheetOpenerRef.current?.focus())
  }

  async function createFamilyEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setEventFormError('')
    const form = new FormData(event.currentTarget)
    const title = String(form.get('title') ?? '').trim()
    const date = String(form.get('date') ?? '')
    const time = String(form.get('time') ?? '')
    const location = String(form.get('location') ?? '').trim()
    const category = parsePlanCategory(form.get('category'))
    if (!title || !date || !time || !location || !category) return

    const startsAt = `${date}T${time}:00`
    setEventSaving(true)
    try {
      const saved = await createFamilyEventRecord({
        title,
        startsAt,
        location,
        details: `${categoryDetailsPrefix}${category}`,
      })
      const newEvent: FamilyEvent = {
        id: saved.id,
        title,
        date,
        time,
        location,
        startsAt,
        category,
      }
      const nextEvents = [...createdEvents, newEvent]
      const persistedOnDevice = writeJson(createdEventsStorageKey, nextEvents)
      if (!saved.synced && !persistedOnDevice) {
        setEventFormError(
          'This plan is not saved yet because device storage is unavailable. Keep this sheet open and try again.',
        )
        return
      }
      setCreatedEvents(nextEvents)
      setIsUpcomingExpanded(true)
      closeEventSheet(true)
      if (saved.synced) void refreshFamilyEvents().catch(() => undefined)
      setReminderStatus(
        saved.synced
          ? `${title} was shared with your family. Choose Remind me for a device alert.`
          : `${title} was saved on this device. Choose Remind me for a device alert.`,
      )
    } catch {
      setEventFormError(
        'The plan could not be saved. Check your connection and try again.',
      )
    } finally {
      setEventSaving(false)
    }
  }

  async function toggleReminder(event: FamilyEvent) {
    if (reminderIds.has(event.id)) {
      const nextIds = new Set(reminderIds)
      nextIds.delete(event.id)
      setReminderIds(nextIds)
      writeJson(reminderIdsStorageKey, [...nextIds])
      const cancellation = await cancelEventReminder(event.id, storageSubject)
      try {
        await syncEventReminder(event.id, false)
      } catch {
        // The local reminder state remains authoritative until sync can retry.
      }
      setReminderStatus(
        cancellation.cleared
          ? `Reminder removed for ${event.title}.`
          : cancellation.message,
      )
      return
    }

    const result = await enableEventReminder(event, storageSubject)
    const nextIds = new Set(reminderIds).add(event.id)
    setReminderIds(nextIds)
    writeJson(reminderIdsStorageKey, [...nextIds])
    try {
      await syncEventReminder(event.id, true)
    } catch {
      // Device scheduling still succeeds if the server is temporarily unavailable.
    }
    setReminderStatus(result.message)
  }

  return (
    <section
      className="journal-events"
      aria-labelledby="journal-events-title"
    >
      <div className="journal-events__heading">
        <div>
          <p>Milestones worth remembering</p>
          <h2 id="journal-events-title">Important plans</h2>
        </div>
        <button
          className="events-header-action"
          type="button"
          aria-haspopup="dialog"
          onClick={openEventSheet}
        >
          <span className="events-header-action__plus" aria-hidden="true">
            +
          </span>
          <span>Add plan</span>
        </button>
      </div>

      <section
        className="ks-section journal-events__upcoming"
        aria-labelledby="upcoming-events-title"
      >
        <div className="ks-section__heading journal-events__upcoming-heading">
          <div>
            <h3 id="upcoming-events-title">Coming up</h3>
            <p>
              {eventsLoading
                ? 'Checking shared plans…'
                : `${allUpcomingEvents.length} ${
                    allUpcomingEvents.length === 1 ? 'family plan' : 'family plans'
                  }`}
            </p>
          </div>
          {allUpcomingEvents.length > 3 ? (
            <button
              className="journal-events__upcoming-toggle"
              type="button"
              aria-expanded={isUpcomingExpanded}
              aria-controls={upcomingListId}
              aria-label={
                isUpcomingExpanded
                  ? 'Show fewer upcoming family plans'
                  : `Show all ${allUpcomingEvents.length} upcoming family events`
              }
              onClick={() => setIsUpcomingExpanded((expanded) => !expanded)}
            >
              <span>{isUpcomingExpanded ? 'Show less' : 'See all'}</span>
              <svg aria-hidden="true" viewBox="0 0 12 8">
                <path d="m1 1 5 5 5-5" />
              </svg>
            </button>
          ) : null}
        </div>
        <div
          className="event-list journal-events__upcoming-list"
          id={upcomingListId}
          data-expanded={isUpcomingExpanded}
        >
          {(isUpcomingExpanded
            ? allUpcomingEvents
            : allUpcomingEvents.slice(0, 3)
          ).map((event, index) => {
            const date = new Date(`${event.date}T12:00:00`)
            const day = new Intl.DateTimeFormat('en', {
              day: '2-digit',
            }).format(date)
            const month = new Intl.DateTimeFormat('en', {
              month: 'short',
            }).format(date)
            const time = new Intl.DateTimeFormat('en', {
              hour: 'numeric',
              minute: '2-digit',
            }).format(new Date(event.startsAt))
            const hasReminder = reminderIds.has(event.id)

            return (
              <article
                key={event.id}
                className={`ks-card event-list-item${
                  index > 0 ? ' journal-events__event--revealed' : ''
                }`}
              >
                <div
                  className="event-list-item__date"
                  aria-label={`${month} ${day}`}
                >
                  <strong>{day}</strong>
                  <span>{month}</span>
                </div>
                <div>
                  <h4>{event.title}</h4>
                  <p>
                    {event.category ? (
                      <>
                        <span className="event-list-item__category">
                          {planCategoryLabel(event.category)}
                        </span>{' '}
                        ·{' '}
                      </>
                    ) : null}
                    {time} · {event.location}
                  </p>
                </div>
                <div className="event-list-item__actions">
                  <button
                    className="event-reminder-button"
                    type="button"
                    aria-label={`${
                      hasReminder ? 'Remove reminder for' : 'Remind me about'
                    } ${event.title}`}
                    aria-pressed={hasReminder}
                    onClick={() => void toggleReminder(event)}
                  >
                    {hasReminder ? 'Reminder on' : 'Remind me'}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
        {!eventsLoading && allUpcomingEvents.length === 0 ? (
          <div className="journal-events__empty">
            <span className="journal-events__empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path
                  d="M7 3v3M17 3v3M4.5 9h15M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"
                />
                <path d="m9 14 2 2 4-5" />
              </svg>
            </span>
            <div>
              <h3>No important plans yet</h3>
              <p>
                Add a trip, graduation, wedding, anniversary, or appointment
                the family should remember.
              </p>
            </div>
            <button
              className="journal-events__empty-action"
              type="button"
              aria-haspopup="dialog"
              onClick={openEventSheet}
            >
              Add your first plan
            </button>
          </div>
        ) : null}
        {sharedEventsUnavailable ? (
          <p className="event-reminder-status" role="status">
            {allUpcomingEvents.length > 0
              ? 'Showing plans saved on this phone. Shared plans could not refresh.'
              : 'Shared plans could not be checked. Try again when you are online.'}
          </p>
        ) : null}
        {reminderStatus ? (
          <p
            className="event-reminder-status"
            role="status"
            aria-live="polite"
          >
            {reminderStatus}
          </p>
        ) : null}
        {allUpcomingEvents.length > 0 ? (
          <p className="journal-events__notification-note">
            Phone reminders work even when the installed app is closed.
          </p>
        ) : null}
      </section>

      {showEventSheet
        ? createPortal(
            <div
              className="event-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="add-event-title"
            >
              <form
                ref={eventSheetRef}
                className="event-sheet__panel"
                onSubmit={(event) => void createFamilyEvent(event)}
              >
                <div className="event-sheet__header">
                  <h2 id="add-event-title">Add an important plan</h2>
                  <button
                    className="event-sheet__close"
                    type="button"
                    aria-label="Close add plan"
                    onClick={() => closeEventSheet()}
                    disabled={eventSaving}
                  >
                    ×
                  </button>
                </div>
                <label className="ks-field">
                  <span>Plan type</span>
                  <select
                    ref={eventSheetFirstFieldRef}
                    name="category"
                    defaultValue=""
                    required
                  >
                    <option value="" disabled>
                      Choose a milestone
                    </option>
                    {planCategories.map((category) => (
                      <option key={category.value} value={category.value}>
                        {category.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ks-field">
                  <span>Plan name</span>
                  <input
                    name="title"
                    maxLength={60}
                    placeholder="Sara’s graduation"
                    required
                  />
                </label>
                <div className="event-sheet__row">
                  <label className="ks-field">
                    <span>Date</span>
                    <input
                      name="date"
                      type="date"
                      min={todayInputValue()}
                      required
                    />
                  </label>
                  <label className="ks-field">
                    <span>Time</span>
                    <input name="time" type="time" required />
                  </label>
                </div>
                <label className="ks-field">
                  <span>Location</span>
                  <input
                    name="location"
                    maxLength={60}
                    placeholder="Airport, campus, venue, or clinic"
                    required
                  />
                </label>
                <p className="event-sheet__hint">
                  Travel, graduations, weddings, anniversaries, and important
                  appointments belong here. You can add a one-hour reminder next.
                </p>
                {eventFormError ? (
                  <p
                    className="event-sheet__error"
                    id={formErrorId}
                    role="alert"
                  >
                    {eventFormError}
                  </p>
                ) : null}
                <button
                  className="ks-primary-button event-sheet__submit"
                  type="submit"
                  disabled={eventSaving}
                >
                  {eventSaving ? 'Saving…' : 'Save plan'}
                </button>
              </form>
            </div>,
            document.body,
          )
        : null}
    </section>
  )
}

function readCreatedEvents(storageKey: string): FamilyEvent[] {
  const value = readJson(storageKey)
  if (!Array.isArray(value)) return []
  return value.filter(isFamilyEvent)
}

function readReminderIds(storageKey: string) {
  const value = readJson(storageKey)
  if (!Array.isArray(value)) return new Set<string>()
  return new Set(value.filter((item): item is string => typeof item === 'string'))
}

function readJson(key: string): unknown {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    // Callers decide whether an in-memory-only update is acceptable.
    return false
  }
}

function isFamilyEvent(value: unknown): value is FamilyEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<FamilyEvent>
  const hasRequiredFields = [
    'id',
    'title',
    'date',
    'time',
    'location',
    'startsAt',
  ].every((key) => typeof event[key as keyof FamilyEvent] === 'string')
  return (
    hasRequiredFields
    && Boolean(parsePlanCategory(event.category))
  )
}

function toFamilyEvent(record: FamilyEventRecord): FamilyEvent | null {
  const category = parsePlanCategory(
    record.details?.startsWith(categoryDetailsPrefix)
      ? record.details.slice(categoryDetailsPrefix.length)
      : null,
  )
  if (!category) return null
  const startsAt = new Date(record.startsAt)
  const year = startsAt.getFullYear()
  const month = String(startsAt.getMonth() + 1).padStart(2, '0')
  const day = String(startsAt.getDate()).padStart(2, '0')
  const hour = String(startsAt.getHours()).padStart(2, '0')
  const minute = String(startsAt.getMinutes()).padStart(2, '0')

  return {
    id: record.id,
    title: record.title,
    startsAt: record.startsAt,
    location: record.location,
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    category,
  }
}

function toImportantFamilyEvents(records: FamilyEventRecord[]) {
  return records
    .map(toFamilyEvent)
    .filter((event): event is FamilyEvent => event !== null)
}

function parsePlanCategory(value: unknown): PlanCategory | undefined {
  if (typeof value !== 'string') return undefined
  return planCategories.find((category) => category.value === value)?.value
}

function planCategoryLabel(category: PlanCategory) {
  return (
    planCategories.find((item) => item.value === category)?.label
    ?? 'Milestone'
  )
}

function todayInputValue() {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
