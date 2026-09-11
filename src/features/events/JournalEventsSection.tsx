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
  deleteFamilyEvent as deleteFamilyEventRecord,
  fetchFamilyEvents,
  subscribeToFamilyEvents,
  syncEventReminder,
  updateFamilyEventDetails,
  type FamilyEventRecord,
} from './eventService'
import {
  eventStorageKey,
  familyEventStorageSubject,
} from './eventStorage'
import {
  decodePlanDetails,
  encodePlanDetails,
  type PlanCategory,
  type PlanDoodleName,
  type PlanTask,
} from './planDetails'

type FamilyEvent = ReminderEvent & {
  date: string
  time: string
  location: string
  category: PlanCategory
  doodle?: PlanDoodleName
  tasks?: PlanTask[]
  demoPresentation?: DemoPlanPresentation
}

type DemoPlanPresentation = {
  attendees: Array<{ name: string; initials: string; avatar?: string }>
  additionalAttendees: number
  checklist: Array<PlanTask & { initiallyDone: boolean }>
  doodle: PlanDoodleName
  timeStyle: 'time-location' | 'weekday-time' | 'next-weekend'
}

type PlanChecklistProgress = Record<string, string[]>
type PlanTaskDefinitions = Record<string, PlanTask[]>
type DraftPlanTask = { id: string; value: string }

const createdEventsKey = 'kinsphere-created-events'
const reminderIdsKey = 'kinsphere-event-reminders'
const checklistProgressKey = 'kinsphere-plan-checklists:v1'
const taskDefinitionsKey = 'kinsphere-plan-tasks:v1'
const completedPlanIdsKey = 'kinsphere-completed-plans:v1'
const pendingPlanDeleteIdsKey = 'kinsphere-pending-plan-deletes:v1'
const planCategories = [
  { value: 'travel', label: 'Travel' },
  { value: 'graduation', label: 'Graduation' },
  { value: 'wedding', label: 'Wedding' },
  { value: 'anniversary', label: 'Anniversary' },
  { value: 'appointment', label: 'Important appointment' },
  { value: 'other', label: 'Other milestone' },
] as const

/**
 * Family plans embedded in Journal. This component owns the same offline,
 * Realtime, and device-reminder behavior that the former Together page used.
 */
export function JournalEventsSection() {
  const { isDevelopmentPreview, user } = useAuth()
  const { snapshot } = useFamilyOnboarding()
  const familyId = snapshot?.kind === 'member'
    ? snapshot.membership.familyId
    : null
  const storageSubject = familyEventStorageSubject(user?.id, familyId)
  const showDemoPlans = Boolean(isDevelopmentPreview)

  return (
    <JournalEventsSectionForFamily
      key={storageSubject}
      storageSubject={storageSubject}
      showDemoPlans={showDemoPlans}
    />
  )
}

/** Remounts all mutable plan state whenever the account/family subject changes. */
function JournalEventsSectionForFamily({
  showDemoPlans,
  storageSubject,
}: {
  showDemoPlans: boolean
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
  const checklistProgressStorageKey = eventStorageKey(
    checklistProgressKey,
    storageSubject,
  )
  const taskDefinitionsStorageKey = eventStorageKey(
    taskDefinitionsKey,
    storageSubject,
  )
  const completedPlanIdsStorageKey = eventStorageKey(
    completedPlanIdsKey,
    storageSubject,
  )
  const pendingPlanDeleteIdsStorageKey = eventStorageKey(
    pendingPlanDeleteIdsKey,
    storageSubject,
  )
  const [isUpcomingExpanded, setIsUpcomingExpanded] = useState(false)
  const [showEventSheet, setShowEventSheet] = useState(false)
  const [eventSaving, setEventSaving] = useState(false)
  const [eventFormError, setEventFormError] = useState('')
  const [timelineOpenedAt] = useState(Date.now)
  const [selectedPlanDay, setSelectedPlanDay] = useState(todayInputValue)
  const demoPlans = useMemo(
    () => showDemoPlans ? createDemoFamilyPlans(timelineOpenedAt) : [],
    [showDemoPlans, timelineOpenedAt],
  )
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
  const [checklistProgress, setChecklistProgress] =
    useState<PlanChecklistProgress>(() =>
      readChecklistProgress(checklistProgressStorageKey),
    )
  const [taskDefinitions, setTaskDefinitions] =
    useState<PlanTaskDefinitions>(() =>
      readPlanTaskDefinitions(taskDefinitionsStorageKey),
    )
  const [draftPlanTasks, setDraftPlanTasks] = useState<DraftPlanTask[]>(() => [
    createDraftPlanTask(),
  ])
  const [taskComposerPlanId, setTaskComposerPlanId] = useState('')
  const [taskComposerValue, setTaskComposerValue] = useState('')
  const [completedPlanIds, setCompletedPlanIds] = useState<Set<string>>(
    () => readStringSet(completedPlanIdsStorageKey),
  )
  const [reminderBusyIds, setReminderBusyIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [completionBusyIds, setCompletionBusyIds] = useState<Set<string>>(
    () => new Set(),
  )
  const eventSheetRef = useRef<HTMLFormElement>(null)
  const eventSheetFirstFieldRef = useRef<HTMLInputElement>(null)
  const eventSheetOpenerRef = useRef<HTMLElement | null>(null)
  const taskComposerInputRef = useRef<HTMLInputElement>(null)
  // Refs close the same-render gap that state alone leaves on rapid taps. The
  // corresponding state sets exist only to reflect the lock in the UI.
  const eventSavingRef = useRef(false)
  const reminderBusyIdsRef = useRef(new Set<string>())
  const completionBusyIdsRef = useRef(new Set<string>())
  const pendingDeleteIdsRef = useRef(
    readStringSet(pendingPlanDeleteIdsStorageKey),
  )
  const pendingDeleteRetryRef = useRef<Promise<void> | null>(null)

  // Merge demo, device, and family sources by ID. Completed plans remain
  // hidden even when a stale Realtime fetch still contains their server row.
  const allUpcomingEvents = useMemo(() => {
    const eventsById = new Map<string, FamilyEvent>()
    for (const event of [
      ...demoPlans,
      ...createdEvents,
      ...sharedFamilyEvents,
    ]) {
      if (completedPlanIds.has(event.id)) continue
      const startsAt = new Date(event.startsAt).getTime()
      if (
        !Number.isFinite(startsAt)
        || (
          !event.demoPresentation
          && event.date < localDateInputValue(new Date(timelineOpenedAt))
        )
      ) continue
      eventsById.set(event.id, event)
    }
    return [...eventsById.values()].sort(
      (left, right) =>
        new Date(left.startsAt).getTime() -
        new Date(right.startsAt).getTime(),
    )
  }, [completedPlanIds, createdEvents, demoPlans, sharedFamilyEvents, timelineOpenedAt])
  const selectedDayEvents = useMemo(
    () => allUpcomingEvents.filter((event) => event.date === selectedPlanDay),
    [allUpcomingEvents, selectedPlanDay],
  )
  const displayedWeek = useMemo(
    () => planWeekForDate(selectedPlanDay),
    [selectedPlanDay],
  )
  const displayedWeekRange = formatPlanWeekRange(displayedWeek)
  const selectedDayLabel = formatPlanDay(selectedPlanDay)

  /** Rehydrates server-backed plans after a successful local create. */
  const refreshFamilyEvents = useCallback(async () => {
    const records = await fetchFamilyEvents()
    setSharedFamilyEvents(toImportantFamilyEvents(records))
    setSharedEventsUnavailable(false)
  }, [])

  // Initial fetch and Realtime notifications share one active-guarded refresh
  // path; the cleanup callback also prevents a late subscription from leaking.
  useEffect(() => {
    let active = true
    let unsubscribe: () => void = () => undefined

    /** Replays durable optimistic deletions one batch at a time. */
    function retryPendingSharedDeletes() {
      // A completed plan disappears locally immediately, but a failed server
      // delete must remain durable across reloads. Serialize retries so initial
      // fetch and Realtime reconnects cannot send the same batch twice.
      if (pendingDeleteRetryRef.current) return pendingDeleteRetryRef.current
      const retry = (async () => {
        let changed = false
        for (const eventId of [...pendingDeleteIdsRef.current]) {
          try {
            if (await deleteFamilyEventRecord(eventId)) {
              pendingDeleteIdsRef.current.delete(eventId)
              changed = true
            }
          } catch {
            // Keep the id queued for the next mount or successful reconnect.
          }
        }
        if (changed) {
          writeJson(
            pendingPlanDeleteIdsStorageKey,
            [...pendingDeleteIdsRef.current],
          )
        }
      })().finally(() => {
        pendingDeleteRetryRef.current = null
      })
      pendingDeleteRetryRef.current = retry
      return retry
    }

    /** Applies a family refresh only while this account-scoped body is mounted. */
    async function refreshWhileActive() {
      try {
        const records = await fetchFamilyEvents()
        if (active) {
          setSharedFamilyEvents(toImportantFamilyEvents(records))
          setSharedEventsUnavailable(false)
        }
        void retryPendingSharedDeletes()
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
  }, [pendingPlanDeleteIdsStorageKey, storageSubject])

  // Promote legacy ID-only reminder selections into restorable event snapshots.
  useEffect(() => {
    const selectedEvents = allUpcomingEvents.filter((event) =>
      reminderIds.has(event.id),
    )
    void adoptDesiredEventReminders(selectedEvents, storageSubject)
  }, [allUpcomingEvents, reminderIds, storageSubject])

  // The add-plan sheet owns scroll locking, initial focus, Escape, and a
  // contained Tab cycle for the full duration of its modal lifecycle.
  useEffect(() => {
    if (!showEventSheet) return
    const frame = window.requestAnimationFrame(() => {
      eventSheetFirstFieldRef.current?.focus()
    })
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    /** Implements Escape handling and keyboard focus containment for the sheet. */
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

  // Focus the inline task field after the selected card has rendered it.
  useEffect(() => {
    if (!taskComposerPlanId) return
    const frame = window.requestAnimationFrame(() => {
      taskComposerInputRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [taskComposerPlanId])

  /** Opens a fresh add-plan draft and remembers where focus should return. */
  function openEventSheet() {
    eventSheetOpenerRef.current = document.activeElement as HTMLElement | null
    setEventFormError('')
    setDraftPlanTasks([createDraftPlanTask()])
    setShowEventSheet(true)
  }

  /** Selects a calendar day and resets its compact plan list. */
  function choosePlanDay(date: string) {
    setSelectedPlanDay(date)
    setIsUpcomingExpanded(false)
  }

  /** Closes the sheet unless a save owns it; successful saves may force close. */
  function closeEventSheet(force = false) {
    if (eventSaving && !force) return
    setShowEventSheet(false)
    window.requestAnimationFrame(() => eventSheetOpenerRef.current?.focus())
  }

  /** Validates, saves, and locally persists a new shared-or-offline plan. */
  async function createFamilyEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (eventSavingRef.current) return
    setEventFormError('')
    const form = new FormData(event.currentTarget)
    const title = String(form.get('title') ?? '').trim()
    const date = String(form.get('date') ?? '')
    const time = String(form.get('time') ?? '')
    const location = String(form.get('location') ?? '').trim()
    const category: PlanCategory = 'other'
    const tasks = form.getAll('tasks')
      .map((value) => String(value).trim())
      .filter(Boolean)
      .slice(0, 12)
      .map((label) => createPlanTask(label))
    if (!title || !date || !time || !location) return

    const startsAt = `${date}T${time}:00`
    const doodle = planDoodleForSeed(`${title}-${date}-${time}`)
    eventSavingRef.current = true
    setEventSaving(true)
    try {
      const saved = await createFamilyEventRecord({
        title,
        startsAt,
        location,
        details: encodePlanDetails({ category, doodle, tasks }),
      })
      const newEvent: FamilyEvent = {
        id: saved.id,
        title,
        date,
        time,
        location,
        startsAt,
        category,
        doodle,
        tasks,
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
      setSelectedPlanDay(date)
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
      eventSavingRef.current = false
      setEventSaving(false)
    }
  }

  /** Updates durable device intent before best-effort family reminder sync. */
  async function toggleReminder(event: FamilyEvent) {
    if (reminderBusyIdsRef.current.has(event.id)) return
    reminderBusyIdsRef.current.add(event.id)
    setReminderBusyIds(new Set(reminderBusyIdsRef.current))
    try {
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
    } finally {
      reminderBusyIdsRef.current.delete(event.id)
      setReminderBusyIds(new Set(reminderBusyIdsRef.current))
    }
  }

  /** Persists one card's device-local checklist completion set. */
  function toggleChecklistItem(
    event: FamilyEvent,
    item: PlanTask,
    checklist: Array<PlanTask & { initiallyDone?: boolean }>,
  ) {
    setChecklistProgress((current) => {
      const completed = new Set(
        current[event.id]
        ?? checklist.filter((task) => task.initiallyDone).map((task) => task.id),
      )
      if (completed.has(item.id)) completed.delete(item.id)
      else completed.add(item.id)
      const next = { ...current, [event.id]: [...completed] }
      if (!writeJson(checklistProgressStorageKey, next)) {
        setReminderStatus(
          'Checklist updated for this session, but it could not be saved on this device.',
        )
      }
      return next
    })
  }

  /** Resolves editable overrides before encoded or demo task definitions. */
  function tasksForPlan(event: FamilyEvent) {
    return taskDefinitions[event.id]
      ?? event.tasks
      ?? event.demoPresentation?.checklist
      ?? []
  }

  /** Toggles the inline task composer for exactly one plan card. */
  function openTaskComposer(eventId: string) {
    setTaskComposerValue('')
    setTaskComposerPlanId((current) => current === eventId ? '' : eventId)
  }

  /** Adds a task optimistically, then shares the encoded definition if possible. */
  async function addTaskToPlan(
    submitEvent: FormEvent<HTMLFormElement>,
    event: FamilyEvent,
  ) {
    submitEvent.preventDefault()
    const label = taskComposerValue.trim()
    if (!label) {
      taskComposerInputRef.current?.focus()
      return
    }
    const currentTasks = tasksForPlan(event)
    if (currentTasks.length >= 12) {
      setReminderStatus('This plan already has the maximum of 12 tasks.')
      return
    }

    const nextTasks = [...currentTasks, createPlanTask(label)]
    const nextDefinitions = { ...taskDefinitions, [event.id]: nextTasks }
    setTaskDefinitions(nextDefinitions)
    writeJson(taskDefinitionsStorageKey, nextDefinitions)

    const doodle = event.doodle
      ?? event.demoPresentation?.doodle
      ?? planDoodleForSeed(event.id)
    const updateEvent = (item: FamilyEvent): FamilyEvent =>
      item.id === event.id ? { ...item, doodle, tasks: nextTasks } : item
    setCreatedEvents((current) => {
      const next = current.map(updateEvent)
      writeJson(createdEventsStorageKey, next)
      return next
    })
    setSharedFamilyEvents((current) => current.map(updateEvent))
    setTaskComposerPlanId('')
    setTaskComposerValue('')

    try {
      const shared = await updateFamilyEventDetails(
        event.id,
        encodePlanDetails({ category: event.category, doodle, tasks: nextTasks }),
      )
      setReminderStatus(
        shared
          ? `“${label}” was added for the whole family.`
          : `“${label}” was added to this plan on this device.`,
      )
    } catch {
      setReminderStatus(
        `“${label}” was saved here. Family sync will retry when the calendar reconnects.`,
      )
    }
  }

  /** Hides a completed plan immediately and queues recoverable server deletion. */
  async function completePlan(event: FamilyEvent) {
    if (completionBusyIdsRef.current.has(event.id)) return
    completionBusyIdsRef.current.add(event.id)
    setCompletionBusyIds(new Set(completionBusyIdsRef.current))
    const isSharedEvent = sharedFamilyEvents.some(({ id }) => id === event.id)
    if (isSharedEvent) {
      pendingDeleteIdsRef.current.add(event.id)
      writeJson(
        pendingPlanDeleteIdsStorageKey,
        [...pendingDeleteIdsRef.current],
      )
    }

    // Completion is optimistic for a reason: a flaky connection should not
    // make a checked-off family plan jump back into the day's notebook.
    setCompletedPlanIds((current) => {
      const next = new Set(current).add(event.id)
      writeJson(completedPlanIdsStorageKey, [...next])
      return next
    })

    setCreatedEvents((current) => {
      const next = current.filter((item) => item.id !== event.id)
      writeJson(createdEventsStorageKey, next)
      return next
    })
    setSharedFamilyEvents((current) =>
      current.filter((item) => item.id !== event.id),
    )

    setTaskDefinitions((current) => {
      const next = { ...current }
      delete next[event.id]
      writeJson(taskDefinitionsStorageKey, next)
      return next
    })
    setChecklistProgress((current) => {
      const next = { ...current }
      delete next[event.id]
      writeJson(checklistProgressStorageKey, next)
      return next
    })
    if (taskComposerPlanId === event.id) {
      setTaskComposerPlanId('')
      setTaskComposerValue('')
    }

    setReminderIds((current) => {
      const next = new Set(current)
      next.delete(event.id)
      writeJson(reminderIdsStorageKey, [...next])
      return next
    })
    await cancelEventReminder(event.id, storageSubject)

    try {
      const removedForFamily = await deleteFamilyEventRecord(event.id)
      if (removedForFamily && isSharedEvent) {
        pendingDeleteIdsRef.current.delete(event.id)
        writeJson(
          pendingPlanDeleteIdsStorageKey,
          [...pendingDeleteIdsRef.current],
        )
      }
      setReminderStatus(
        removedForFamily
          ? `${event.title} was completed and removed from the shared calendar.`
          : `${event.title} was completed and removed from this calendar.`,
      )
    } catch {
      setReminderStatus(
        `${event.title} was removed here. Shared removal will retry when the family calendar reconnects.`,
      )
    } finally {
      completionBusyIdsRef.current.delete(event.id)
      setCompletionBusyIds(new Set(completionBusyIdsRef.current))
    }
  }

  return (
    <section
      className="journal-events"
      aria-labelledby="journal-events-title"
    >
      <div className="journal-events__heading journal-events__sr-only">
        <div>
          <p>Milestones worth remembering</p>
          <h2 id="journal-events-title">Important plans</h2>
        </div>
      </div>

      <nav
        className="journal-events__week"
        aria-label={`Family plans, ${displayedWeekRange}`}
      >
        <div className="journal-events__week-days">
          {displayedWeek.map((date) => {
            const dateValue = localDateInputValue(date)
            const selected = dateValue === selectedPlanDay
            const hasPlans = allUpcomingEvents.some(
              (event) => event.date === dateValue,
            )
            const weekday = new Intl.DateTimeFormat('en', {
              weekday: 'long',
            }).format(date)
            return (
              <button
                key={dateValue}
                type="button"
                aria-label={`${weekday}, ${new Intl.DateTimeFormat('en', {
                  month: 'long',
                  day: 'numeric',
                }).format(date)}${hasPlans ? ', has plans' : ''}`}
                aria-pressed={selected}
                data-has-plans={hasPlans ? 'true' : 'false'}
                onClick={() => choosePlanDay(dateValue)}
              >
                <span aria-hidden="true">{weekday.slice(0, 1)}</span>
                <strong>{date.getDate()}</strong>
                <i aria-hidden="true" />
              </button>
            )
          })}
        </div>
        <div className="journal-events__week-navigation">
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => choosePlanDay(shiftPlanDay(selectedPlanDay, -7))}
          >
            <svg aria-hidden="true" viewBox="0 0 12 12">
              <path d="m7.5 2-4 4 4 4" />
            </svg>
          </button>
          <p aria-live="polite">{displayedWeekRange}</p>
          <button
            type="button"
            aria-label="Next week"
            onClick={() => choosePlanDay(shiftPlanDay(selectedPlanDay, 7))}
          >
            <svg aria-hidden="true" viewBox="0 0 12 12">
              <path d="m4.5 2 4 4-4 4" />
            </svg>
          </button>
        </div>
      </nav>

      <section
        className="ks-section journal-events__upcoming"
        aria-labelledby="upcoming-events-title"
      >
        <div className="journal-events__upcoming-heading journal-events__sr-only">
          <div>
            <h3 id="upcoming-events-title">Coming up</h3>
            <p>
              {eventsLoading
                ? 'Checking shared plans…'
                : `${selectedDayEvents.length} ${
                    selectedDayEvents.length === 1 ? 'family plan' : 'family plans'
                  }`}
            </p>
          </div>
        </div>
        <div
          className="event-list journal-events__upcoming-list"
          id={upcomingListId}
          data-expanded={isUpcomingExpanded}
        >
          {(isUpcomingExpanded
            ? selectedDayEvents
            : selectedDayEvents.slice(0, 3)
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
            const weekday = new Intl.DateTimeFormat('en', {
              weekday: 'long',
            }).format(date)
            const hasReminder = reminderIds.has(event.id)
            const categoryLabel = planCategoryLabel(event.category)
            const presentation = event.demoPresentation
            const checklist = tasksForPlan(event)
            const doodle = event.doodle
              ?? presentation?.doodle
              ?? planDoodleForSeed(event.id)
            const completedChecklistItems = new Set(
              checklistProgress[event.id]
              ?? checklist
                .filter(taskStartsCompleted)
                .map((item) => item.id)
              ?? [],
            )

            return (
              <article
                key={event.id}
                className={`ks-card event-list-item event-plan-card${
                  index > 0 ? ' journal-events__event--revealed' : ''
                }`}
                data-category={event.category}
              >
                <div className="event-plan-card__artwork" aria-hidden="true">
                  <span className="event-plan-card__sketch">
                    <PlanDoodle doodle={doodle} />
                  </span>
                  <time
                    className="event-plan-card__date journal-events__sr-only"
                    dateTime={event.date}
                    aria-label={`${weekday}, ${month} ${day}`}
                  >
                    <strong>{day}</strong>
                    <span>{month}</span>
                  </time>
                </div>
                <div className="event-plan-card__content">
                  <div className="event-plan-card__title-row">
                    <div>
                      <span className="event-list-item__category journal-events__sr-only">
                        {categoryLabel}
                      </span>
                      <h4>{event.title}</h4>
                    </div>
                    <button
                      className="event-reminder-button event-plan-card__doodle"
                      type="button"
                      aria-label={`${
                        hasReminder ? 'Remove reminder for' : 'Remind me about'
                      } ${event.title}`}
                      aria-pressed={hasReminder}
                      aria-busy={reminderBusyIds.has(event.id)}
                      disabled={reminderBusyIds.has(event.id)}
                      onClick={() => void toggleReminder(event)}
                    >
                      <ReminderBellDoodle />
                      <span className="journal-events__sr-only">
                        {hasReminder ? 'Reminder on' : 'Remind me'}
                      </span>
                    </button>
                  </div>
                  <p className="event-plan-card__when">
                    <time dateTime={event.startsAt}>
                      {presentation?.timeStyle === 'time-location'
                        ? time
                        : presentation?.timeStyle === 'next-weekend'
                          ? 'Next weekend'
                          : `${weekday} · ${time}`}
                    </time>
                    {presentation?.timeStyle === 'time-location' ? (
                      <span> · {event.location}</span>
                    ) : null}
                  </p>
                  {!presentation ? (
                    <p className="event-plan-card__location">{event.location}</p>
                  ) : null}
                  {presentation ? (
                    <div
                      className="event-plan-card__attendees"
                      aria-label={`Going: ${presentation.attendees
                        .map((attendee) => attendee.name)
                        .join(', ')}${presentation.additionalAttendees > 0
                        ? `, plus ${presentation.additionalAttendees} more`
                        : ''}`}
                    >
                      {presentation.attendees.map((attendee) => (
                        <span key={attendee.name} title={attendee.name}>
                          {attendee.initials}
                        </span>
                      ))}
                      {presentation.additionalAttendees > 0 ? (
                        <span aria-hidden="true">
                          +{presentation.additionalAttendees}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {checklist.length > 0 ? (
                  <ul
                    className="event-plan-card__checklist"
                    aria-label={`${event.title} checklist`}
                  >
                    {checklist.map((item) => {
                      const checked = completedChecklistItems.has(item.id)
                      return (
                        <li key={item.id}>
                          <label data-checked={checked ? 'true' : 'false'}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleChecklistItem(event, item, checklist)}
                            />
                            <span className="event-plan-card__checkbox" aria-hidden="true">
                              <svg viewBox="0 0 16 16">
                                <path d="m3 8 3 3 7-8" />
                              </svg>
                            </span>
                            <span>{item.label}</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
                {taskComposerPlanId === event.id ? (
                  <form
                    className="event-plan-card__task-composer"
                    aria-label={`Add task to ${event.title}`}
                    onSubmit={(submitEvent) => void addTaskToPlan(submitEvent, event)}
                  >
                    <label htmlFor={`plan-task-${event.id}`}>New task</label>
                    <div>
                      <input
                        ref={taskComposerInputRef}
                        id={`plan-task-${event.id}`}
                        value={taskComposerValue}
                        maxLength={80}
                        placeholder="Bring dessert"
                        enterKeyHint="done"
                        onChange={(changeEvent) => setTaskComposerValue(changeEvent.target.value)}
                        onKeyDown={(keyEvent) => {
                          if (keyEvent.key === 'Escape') {
                            setTaskComposerPlanId('')
                            setTaskComposerValue('')
                          }
                        }}
                      />
                      <button type="submit">Save</button>
                    </div>
                  </form>
                ) : null}
                <div className="event-plan-card__actions">
                  <button
                    className="event-plan-card__add-task"
                    type="button"
                    aria-expanded={taskComposerPlanId === event.id}
                    onClick={() => openTaskComposer(event.id)}
                  >
                    <span aria-hidden="true">＋</span>
                    <span>{taskComposerPlanId === event.id ? 'Cancel' : 'Add task'}</span>
                    <span className="journal-action-spacer" aria-hidden="true" />
                  </button>
                  <button
                    className="event-plan-card__complete"
                    type="button"
                    aria-label={`Complete task: ${event.title}`}
                    aria-busy={completionBusyIds.has(event.id)}
                    disabled={completionBusyIds.has(event.id)}
                    onClick={() => void completePlan(event)}
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20">
                      <path d="m4 10 4 4 8-9" />
                    </svg>
                    <span>Complete task</span>
                    <span className="journal-action-spacer" aria-hidden="true" />
                  </button>
                </div>
              </article>
            )
          })}
        </div>
        {selectedDayEvents.length > 3 ? (
          <button
            className="journal-events__upcoming-toggle"
            type="button"
            aria-expanded={isUpcomingExpanded}
            aria-controls={upcomingListId}
            aria-label={
              isUpcomingExpanded
                ? 'Show fewer upcoming family plans'
                : `Show all ${selectedDayEvents.length} plans on ${selectedDayLabel}`
            }
            onClick={() => setIsUpcomingExpanded((expanded) => !expanded)}
          >
            <span>{isUpcomingExpanded ? 'Show less' : 'See all'}</span>
            <svg aria-hidden="true" viewBox="0 0 12 8">
              <path d="m1 1 5 5 5-5" />
            </svg>
          </button>
        ) : null}
        {!eventsLoading && selectedDayEvents.length === 0 ? (
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
              <h3>No plans on {selectedDayLabel}</h3>
              <p>
                Choose another date or add a plan for this day to the shared
                family calendar.
              </p>
              <button
                className="journal-events__empty-action"
                type="button"
                onClick={openEventSheet}
              >
                <span aria-hidden="true">＋</span>
                <span>Add a plan for this day</span>
                <span className="journal-action-spacer" aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
        {sharedEventsUnavailable ? (
          <p className="event-reminder-status" role="status">
            {selectedDayEvents.length > 0
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
        {selectedDayEvents.length > 0 ? (
          <p className="journal-events__notification-note">
            Phone reminders work even when the installed app is closed.
          </p>
        ) : null}
      </section>

      <button
        className="events-header-action events-header-action--footer"
        type="button"
        aria-haspopup="dialog"
        onClick={openEventSheet}
      >
        <span className="events-header-action__plus" aria-hidden="true">+</span>
        <span>Add plan</span>
        <span className="journal-action-spacer" aria-hidden="true" />
      </button>

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
                  <span>Plan name</span>
                  <input
                    ref={eventSheetFirstFieldRef}
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
                <fieldset className="event-sheet__tasks">
                  <div className="event-sheet__tasks-heading">
                    <div>
                      <legend>Tasks</legend>
                      <p>Optional little jobs for everyone.</p>
                    </div>
                    <button
                      type="button"
                      disabled={draftPlanTasks.length >= 12}
                      onClick={() => setDraftPlanTasks((current) => [
                        ...current,
                        createDraftPlanTask(),
                      ])}
                    >
                      <span aria-hidden="true">＋</span>
                      Add task
                    </button>
                  </div>
                  <div className="event-sheet__task-list">
                    {draftPlanTasks.map((task, index) => (
                      <div className="event-sheet__task-row" key={task.id}>
                        <label htmlFor={`draft-plan-task-${task.id}`}>
                          {index === 0 ? 'First task' : `Task ${index + 1}`}
                        </label>
                        <div>
                          <input
                            id={`draft-plan-task-${task.id}`}
                            name="tasks"
                            value={task.value}
                            maxLength={80}
                            placeholder={index === 0 ? 'Bring dessert' : 'Add another little job'}
                            onChange={(changeEvent) => {
                              const value = changeEvent.target.value
                              setDraftPlanTasks((current) => current.map((item) =>
                                item.id === task.id ? { ...item, value } : item,
                              ))
                            }}
                          />
                          {draftPlanTasks.length > 1 ? (
                            <button
                              type="button"
                              aria-label={`Remove task ${index + 1}`}
                              onClick={() => setDraftPlanTasks((current) =>
                                current.filter((item) => item.id !== task.id),
                              )}
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </fieldset>
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

/** Reads only structurally valid device-created plans from JSON storage. */
function readCreatedEvents(storageKey: string): FamilyEvent[] {
  const value = readJson(storageKey)
  if (!Array.isArray(value)) return []
  return value.filter(isFamilyEvent)
}

/** Migrates the former ID-only reminder selection into a bounded set. */
function readReminderIds(storageKey: string) {
  const value = readJson(storageKey)
  if (!Array.isArray(value)) return new Set<string>()
  return new Set(value.filter((item): item is string => typeof item === 'string'))
}

/** Reads a bounded string set used by completion and retry registries. */
function readStringSet(storageKey: string) {
  const value = readJson(storageKey)
  if (!Array.isArray(value)) return new Set<string>()
  return new Set(
    value.filter((item): item is string =>
      typeof item === 'string' && item.length <= 160,
    ),
  )
}

/** Validates device-local task overrides at their persistence boundary. */
function readPlanTaskDefinitions(storageKey: string): PlanTaskDefinitions {
  const value = readJson(storageKey)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value)
      .filter(([eventId, tasks]) => (
        eventId.length <= 160
        && Array.isArray(tasks)
      ))
      .map(([eventId, tasks]) => [
        eventId,
        (tasks as unknown[])
          .filter(isPlanTask)
          .slice(0, 12),
      ]),
  )
}

/** Parses optional local JSON without letting storage failures break Journal. */
function readJson(key: string): unknown {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

/** Reports whether a value became durable so callers can surface degraded mode. */
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    // Callers decide whether an in-memory-only update is acceptable.
    return false
  }
}

/** Validates the persisted subset of a family plan, including nested tasks. */
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
    && (event.doodle === undefined || isPlanDoodleName(event.doodle))
    && (event.tasks === undefined || (
      Array.isArray(event.tasks)
      && event.tasks.length <= 12
      && event.tasks.every(isPlanTask)
    ))
  )
}

/** Decodes a shared event and derives device-local calendar fields. */
function toFamilyEvent(record: FamilyEventRecord): FamilyEvent | null {
  const details = decodePlanDetails(record.details)
  if (!details) return null
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
    category: details.category,
    doodle: details.doodle,
    tasks: details.tasks,
  }
}

/** Keeps only shared events that carry valid structured plan details. */
function toImportantFamilyEvents(records: FamilyEventRecord[]) {
  return records
    .map(toFamilyEvent)
    .filter((event): event is FamilyEvent => event !== null)
}

/** Narrows persisted category values against the UI's supported choices. */
function parsePlanCategory(value: unknown): PlanCategory | undefined {
  if (typeof value !== 'string') return undefined
  return planCategories.find((category) => category.value === value)?.value
}

/** Validates decorative names before they select an SVG branch. */
function isPlanDoodleName(value: unknown): value is PlanDoodleName {
  return value === 'heart' || value === 'star' || value === 'sun' || value === 'fish'
}

/** Bounds untrusted task IDs and labels before rendering or re-encoding them. */
function isPlanTask(value: unknown): value is PlanTask {
  if (!value || typeof value !== 'object') return false
  const task = value as Partial<PlanTask>
  return (
    typeof task.id === 'string'
    && task.id.length > 0
    && task.id.length <= 160
    && typeof task.label === 'string'
    && task.label.trim().length > 0
    && task.label.length <= 80
  )
}

/** Reads the demo-only initial completion marker without widening PlanTask. */
function taskStartsCompleted(
  task: PlanTask,
): task is PlanTask & { initiallyDone: true } {
  return 'initiallyDone' in task && task.initiallyDone === true
}

/** Creates a collision-resistant task ID and enforces the shared label limit. */
function createPlanTask(label: string): PlanTask {
  const randomSuffix = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return { id: `task-${randomSuffix}`, label: label.trim().slice(0, 80) }
}

/** Reuses production task ID generation for an initially empty form row. */
function createDraftPlanTask(): DraftPlanTask {
  const task = createPlanTask('New task')
  return { id: task.id, value: '' }
}

/** Selects stable artwork so a plan does not change decoration between renders. */
function planDoodleForSeed(seed: string): PlanDoodleName {
  const doodles: PlanDoodleName[] = ['star', 'sun', 'fish', 'heart']
  const hash = [...seed].reduce(
    (current, character) => ((current * 31) + character.charCodeAt(0)) >>> 0,
    7,
  )
  return doodles[hash % doodles.length]
}

/** Maps stored category codes to human-readable card labels. */
function planCategoryLabel(category: PlanCategory) {
  return (
    planCategories.find((item) => item.value === category)?.label
    ?? 'Milestone'
  )
}

/** Renders one decorative plan motif outside the accessibility tree. */
function PlanDoodle({ doodle }: { doodle: PlanDoodleName }) {
  if (doodle === 'heart') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 27S5 21 5 12.8C5 8.2 10.6 6 16 12c5.4-6 11-3.8 11 1 0 8-11 14-11 14Z" />
      </svg>
    )
  }
  if (doodle === 'star') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="m16 3.5 3.7 8 8.7 1-6.5 5.8 1.8 8.5-7.7-4.5-7.7 4.5 1.8-8.5-6.5-5.8 8.7-1Z" />
        <path d="m16 8 1.9 5.8 6 .1-4.8 3.5 1.7 5.8-4.8-3.5-4.8 3.5 1.7-5.8-4.8-3.5 6-.1Z" />
      </svg>
    )
  }
  if (doodle === 'sun') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="6" />
        <path d="M16 2v5m0 18v5M2 16h5m18 0h5M6.1 6.1l3.6 3.6m12.6 12.6 3.6 3.6m0-19.8-3.6 3.6M9.7 22.3l-3.6 3.6" />
      </svg>
    )
  }
  if (doodle === 'fish') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M5 16c4.2-6.3 11.7-8.4 18-3.2l5-3v12.4l-5-3C16.7 24.4 9.2 22.3 5 16Z" />
        <circle cx="20" cy="14.3" r="0.8" />
        <path d="M10 12.5c1.8 2.1 1.8 4.9 0 7m4.5-9.1 2.2-3.2 2.1 3.9" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 27S5 21 5 12.8C5 8.2 10.6 6 16 12c5.4-6 11-3.8 11 1 0 8-11 14-11 14Z" />
    </svg>
  )
}

/** Renders the shared reminder-control glyph. */
function ReminderBellDoodle() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M9 22h14l-2-3.2V14a5 5 0 0 0-10 0v4.8Zm5 3h4" />
      <path d="M8 8.5c-1.5 1.4-2.2 3.2-2.2 5.2m18.4-5.2c1.5 1.4 2.2 3.2 2.2 5.2" />
    </svg>
  )
}

/** Builds stable preview plans near the mount date without entering persistence. */
function createDemoFamilyPlans(anchorTimestamp: number): FamilyEvent[] {
  const anchor = new Date(anchorTimestamp)
  const dayInWeek = (anchor.getDay() + 6) % 7
  const secondOffset = dayInWeek < 6 ? 1 : -1
  const thirdOffset = dayInWeek < 5 ? 2 : -2
  const sundayDinner = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate(),
    18,
    30,
  )
  const mayasBirthday = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate() + secondOffset,
    16,
  )
  const beachDay = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate() + thirdOffset,
    9,
  )
  const plans: Array<Omit<FamilyEvent, 'date' | 'time' | 'startsAt'> & {
    startsAtDate: Date
  }> = [
    {
      id: 'demo-plan-sunday-dinner',
      title: 'Sunday dinner',
      startsAtDate: sundayDinner,
      location: 'At Mum’s',
      category: 'other',
      demoPresentation: {
        attendees: [
          { name: 'Mum', initials: 'MU' },
          { name: 'Maya', initials: 'MA' },
          { name: 'Sara', initials: 'SA' },
          { name: 'Hishaam', initials: 'HI' },
          { name: 'Rami', initials: 'RA' },
        ],
        additionalAttendees: 2,
        checklist: [
          { id: 'ask-dessert', label: 'Ask Maya what dessert she wants', initiallyDone: true },
          { id: 'bring-flowers', label: 'Bring flowers for Mum', initiallyDone: false },
          { id: 'pick-up-bread', label: 'Pick up bread', initiallyDone: true },
        ],
        doodle: 'heart',
        timeStyle: 'time-location',
      },
    },
    {
      id: 'demo-plan-mayas-birthday',
      title: 'Maya’s birthday',
      startsAtDate: mayasBirthday,
      location: 'Family home',
      category: 'anniversary',
      demoPresentation: {
        attendees: [
          { name: 'Grandad', initials: 'GR' },
          { name: 'Mum', initials: 'MU' },
          { name: 'Maya', initials: 'MA' },
          { name: 'Sara', initials: 'SA' },
          { name: 'Hishaam', initials: 'HI' },
        ],
        additionalAttendees: 1,
        checklist: [
          { id: 'buy-candles', label: 'Buy candles', initiallyDone: true },
          { id: 'wrap-gift', label: 'Wrap gift', initiallyDone: true },
          { id: 'book-venue', label: 'Book the venue', initiallyDone: false },
        ],
        doodle: 'star',
        timeStyle: 'weekday-time',
      },
    },
    {
      id: 'demo-plan-family-beach-day',
      title: 'Family beach day',
      startsAtDate: beachDay,
      location: 'Jumeirah Beach',
      category: 'travel',
      demoPresentation: {
        attendees: [
          { name: 'Mum', initials: 'MU' },
          { name: 'Maya', initials: 'MA' },
          { name: 'Sara', initials: 'SA' },
          { name: 'Rami', initials: 'RA' },
        ],
        additionalAttendees: 3,
        checklist: [
          { id: 'pack-snacks', label: 'Pack snacks', initiallyDone: false },
          { id: 'sunscreen', label: 'Sunscreen', initiallyDone: true },
          { id: 'beach-games', label: 'Beach games', initiallyDone: false },
        ],
        doodle: 'sun',
        timeStyle: 'next-weekend',
      },
    },
  ]

  return plans.map((plan) => {
    const { startsAtDate: startsAt, ...event } = plan
    const year = startsAt.getFullYear()
    const month = String(startsAt.getMonth() + 1).padStart(2, '0')
    const day = String(startsAt.getDate()).padStart(2, '0')
    const hour = String(startsAt.getHours()).padStart(2, '0')
    const minute = String(startsAt.getMinutes()).padStart(2, '0')

    return {
      ...event,
      startsAt: startsAt.toISOString(),
      date: `${year}-${month}-${day}`,
      time: `${hour}:${minute}`,
    }
  })
}

/** Validates per-plan completed task IDs loaded from device storage. */
function readChecklistProgress(storageKey: string): PlanChecklistProgress {
  const value = readJson(storageKey)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([eventId, completed]) =>
        eventId.length <= 160
        && Array.isArray(completed),
      )
      .map(([eventId, completed]) => [
        eventId,
        (completed as unknown[]).filter((item): item is string =>
          typeof item === 'string' && item.length <= 120,
        ),
      ]),
  )
}

/** Returns the Monday-through-Sunday local week containing an input date. */
function planWeekForDate(value: string) {
  const selected = new Date(`${value}T12:00:00`)
  const mondayOffset = (selected.getDay() + 6) % 7
  const monday = new Date(
    selected.getFullYear(),
    selected.getMonth(),
    selected.getDate() - mondayOffset,
    12,
  )
  return Array.from({ length: 7 }, (_, index) => new Date(
    monday.getFullYear(),
    monday.getMonth(),
    monday.getDate() + index,
    12,
  ))
}

/** Produces the compact heading for a complete displayed week. */
function formatPlanWeekRange(week: Date[]) {
  const first = week[0]
  const last = week.at(-1)
  if (!first || !last) return ''
  const format = (date: Date) => new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(date)
  return `${format(first)} – ${format(last)}`
}

/** Formats a local input date without UTC day rollover. */
function formatPlanDay(value: string) {
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

/** Moves calendar selection by whole local days, with a safe invalid fallback. */
function shiftPlanDay(value: string, days: number) {
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime())) return todayInputValue()
  date.setDate(date.getDate() + days)
  return localDateInputValue(date)
}

/** Serializes a Date for an HTML date field in device-local time. */
function localDateInputValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Returns today's HTML date value in device-local time. */
function todayInputValue() {
  return localDateInputValue(new Date())
}
