import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../auth'
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
import { eventStorageKey } from './eventStorage'

type FamilyEvent = ReminderEvent & {
  date: string
  time: string
  location: string
}

const createdEventsKey = 'kinsphere-created-events'
const reminderIdsKey = 'kinsphere-event-reminders'

const upcomingEvents: FamilyEvent[] = [
  {
    id: 'beach-breakfast',
    date: '2026-09-18',
    time: '07:30',
    startsAt: '2026-09-18T07:30:00',
    title: 'Beach breakfast',
    location: 'Kite Beach',
  },
  {
    id: 'sara-graduation',
    date: '2026-10-02',
    time: '18:00',
    startsAt: '2026-10-02T18:00:00',
    title: 'Sara’s graduation',
    location: 'Family room',
  },
  {
    id: 'grandad-story-night',
    date: '2026-11-21',
    time: '20:00',
    startsAt: '2026-11-21T20:00:00',
    title: 'Grandad’s story night',
    location: 'Video call',
  },
]

/**
 * Family plans embedded in Journal. This component owns the same offline,
 * Realtime, and device-reminder behavior that the former Together page used.
 */
export function JournalEventsSection() {
  const { user } = useAuth()
  const upcomingListId = useId()
  const storageSubject = user?.id ?? 'signed-out'
  const createdEventsStorageKey = eventStorageKey(
    createdEventsKey,
    storageSubject,
  )
  const reminderIdsStorageKey = eventStorageKey(
    reminderIdsKey,
    storageSubject,
  )
  const [isGoing, setIsGoing] = useState(false)
  const [isUpcomingExpanded, setIsUpcomingExpanded] = useState(false)
  const [showEventSheet, setShowEventSheet] = useState(false)
  const [eventSaving, setEventSaving] = useState(false)
  const [createdEvents, setCreatedEvents] = useState<FamilyEvent[]>(() =>
    readCreatedEvents(createdEventsStorageKey),
  )
  const [sharedFamilyEvents, setSharedFamilyEvents] = useState<FamilyEvent[]>([])
  const [reminderIds, setReminderIds] = useState<Set<string>>(
    () =>
      new Set([
        ...readReminderIds(reminderIdsStorageKey),
        ...readDesiredEventReminders(storageSubject).map((event) => event.id),
      ]),
  )
  const [reminderStatus, setReminderStatus] = useState('')

  const allUpcomingEvents = useMemo(() => {
    const eventsById = new Map<string, FamilyEvent>()
    for (const event of [
      ...upcomingEvents,
      ...createdEvents,
      ...sharedFamilyEvents,
    ]) {
      eventsById.set(event.id, event)
    }
    return [...eventsById.values()].sort(
      (left, right) =>
        new Date(left.startsAt).getTime() -
        new Date(right.startsAt).getTime(),
    )
  }, [createdEvents, sharedFamilyEvents])

  const refreshFamilyEvents = useCallback(async () => {
    const records = await fetchFamilyEvents()
    setSharedFamilyEvents(records.map(toFamilyEvent))
  }, [])

  useEffect(() => {
    let active = true
    let unsubscribe: () => void = () => undefined

    async function refreshWhileActive() {
      try {
        const records = await fetchFamilyEvents()
        if (active) setSharedFamilyEvents(records.map(toFamilyEvent))
      } catch {
        // Keep demo and locally-created events available while offline.
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
  }, [])

  useEffect(() => {
    const selectedEvents = allUpcomingEvents.filter((event) =>
      reminderIds.has(event.id),
    )
    void adoptDesiredEventReminders(selectedEvents, storageSubject)
  }, [allUpcomingEvents, reminderIds, storageSubject])

  useEffect(() => {
    if (!showEventSheet) return

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setShowEventSheet(false)
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [showEventSheet])

  async function createFamilyEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const title = String(form.get('title') ?? '').trim()
    const date = String(form.get('date') ?? '')
    const time = String(form.get('time') ?? '')
    const location = String(form.get('location') ?? '').trim()
    if (!title || !date || !time || !location) return

    const startsAt = `${date}T${time}:00`
    setEventSaving(true)
    try {
      const saved = await createFamilyEventRecord({
        title,
        startsAt,
        location,
      })
      const newEvent: FamilyEvent = {
        id: saved.id,
        title,
        date,
        time,
        location,
        startsAt,
      }
      const nextEvents = [...createdEvents, newEvent]
      setCreatedEvents(nextEvents)
      writeJson(createdEventsStorageKey, nextEvents)
      setIsUpcomingExpanded(true)
      setShowEventSheet(false)
      if (saved.synced) void refreshFamilyEvents().catch(() => undefined)
      setReminderStatus(
        saved.synced
          ? `${title} was shared with your family. Tap Remind me for a device alert.`
          : `${title} was added on this device. Tap Remind me for a device alert.`,
      )
    } catch {
      setReminderStatus(
        'The event could not be saved. Check your connection and try again.',
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
          <p>Family plans</p>
          <h2 id="journal-events-title">What’s ahead</h2>
        </div>
        <button
          className="events-header-action"
          type="button"
          aria-haspopup="dialog"
          onClick={() => setShowEventSheet(true)}
        >
          <span className="events-header-action__plus" aria-hidden="true">
            +
          </span>
          <span>Add event</span>
        </button>
      </div>

      <article
        className="ks-card event-hero"
        aria-labelledby="featured-event-title"
      >
        <div className="event-hero__top">
          <div className="event-hero__date" aria-label="September 6">
            <strong>06</strong>
            <span>Sep</span>
          </div>
        </div>
        <div className="event-hero__body">
          <h3 id="featured-event-title">Family dinner</h3>
          <p>Saturday · 7:00 PM · The courtyard</p>
          <div className="event-hero__footer">
            <div
              className="ks-avatar-stack"
              aria-label="Mum, Hishaam, and four more are attending"
            >
              <span className="ks-avatar" aria-hidden="true">
                MA
              </span>
              <span className="ks-avatar" aria-hidden="true">
                HM
              </span>
              <span className="ks-avatar" aria-hidden="true">
                SA
              </span>
              <span className="ks-avatar" aria-hidden="true">
                +4
              </span>
            </div>
            <button
              className="event-rsvp"
              type="button"
              aria-pressed={isGoing}
              onClick={() => setIsGoing((value) => !value)}
            >
              {isGoing ? '✓ Going' : 'I’m going'}
            </button>
          </div>
        </div>
      </article>

      <section
        className="ks-section journal-events__upcoming"
        aria-labelledby="upcoming-events-title"
      >
        <div className="ks-section__heading journal-events__upcoming-heading">
          <div>
            <h3 id="upcoming-events-title">Coming up</h3>
            <p>
              {allUpcomingEvents.length}{' '}
              {allUpcomingEvents.length === 1 ? 'family plan' : 'family plans'}
            </p>
          </div>
          {allUpcomingEvents.length > 1 ? (
            <button
              className="journal-events__upcoming-toggle"
              type="button"
              aria-expanded={isUpcomingExpanded}
              aria-controls={upcomingListId}
              aria-label={
                isUpcomingExpanded
                  ? 'Show only the next upcoming family event'
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
            : allUpcomingEvents.slice(0, 1)
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
                    {time} · {event.location}
                  </p>
                </div>
                <div className="event-list-item__actions">
                  <button
                    className="event-reminder-button"
                    type="button"
                    aria-label={`${hasReminder ? 'Remove reminder for' : 'Remind me about'} ${event.title}`}
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
        {reminderStatus ? (
          <p
            className="event-reminder-status"
            role="status"
            aria-live="polite"
          >
            {reminderStatus}
          </p>
        ) : null}
        <p className="event-reminder-status">
          The installed iPhone or Android app can alert you while it is closed. In
          a browser, this tab must stay open.
        </p>
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
                className="event-sheet__panel"
                onSubmit={(event) => void createFamilyEvent(event)}
              >
                <div className="event-sheet__header">
                  <h2 id="add-event-title">Add a family event</h2>
                  <button
                    className="event-sheet__close"
                    type="button"
                    aria-label="Close add event"
                    onClick={() => setShowEventSheet(false)}
                    disabled={eventSaving}
                  >
                    ×
                  </button>
                </div>
                <label className="ks-field">
                  <span>What’s happening?</span>
                  <input
                    name="title"
                    autoFocus
                    maxLength={60}
                    placeholder="Friday dinner"
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
                  <span>Where?</span>
                  <input
                    name="location"
                    maxLength={60}
                    placeholder="Home, the park, or a video call"
                    required
                  />
                </label>
                <p className="event-sheet__hint">
                  After adding it, choose “Remind me” to save a one-hour reminder
                  and allow phone notifications. Browser reminders need this tab to
                  stay open.
                </p>
                <button
                  className="ks-primary-button event-sheet__submit"
                  type="submit"
                  disabled={eventSaving}
                >
                  {eventSaving ? 'Adding…' : 'Add to Journal'}
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
  } catch {
    // State still works for this session when private storage is unavailable.
  }
}

function isFamilyEvent(value: unknown): value is FamilyEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<FamilyEvent>
  return ['id', 'title', 'date', 'time', 'location', 'startsAt'].every(
    (key) => typeof event[key as keyof FamilyEvent] === 'string',
  )
}

function toFamilyEvent(record: FamilyEventRecord): FamilyEvent {
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
  }
}

function todayInputValue() {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
