import type { PlanTask } from '../events/planDetails'
import type {
  CapsuleImageSource,
  CapsulePhoto,
  FamilyCapsule,
} from '../capsules/types'
import type { AppTheme } from '../../theme/AppTheme'
import {
  addLocalDays,
  startOfCapsuleWeek,
  toLocalDateInput,
} from '../capsules/capsuleDates'

const twoHoursMs = 2 * 60 * 60 * 1_000
const maxScheduledTransitions = 12
const maxScheduledBytes = 24 * 1_024

export type BubbleWidgetKind =
  | 'urgent'
  | 'unlock'
  | 'today'
  | 'capture'
  | 'memory'
  | 'empty'

export type BubbleWidgetPrivacy = 'full' | 'hidden'

export type BubbleWidgetCard = {
  kind: BubbleWidgetKind
  theme: AppTheme
  eyebrow: string
  title: string
  subtitle?: string
  badge?: string
  route: string
  privacy: BubbleWidgetPrivacy
}

export type BubbleWidgetScheduleEntry = BubbleWidgetCard & {
  effectiveAt: string
}

export type BubbleWidgetSnapshot = BubbleWidgetCard & {
  version: 1
  generatedAt: string
  nextRefreshAt?: string
  /**
   * Bounded, text-only state changes native widgets can apply while the web
   * view is suspended. The current thumbnail is intentionally never copied
   * into a future entry.
   */
  schedule?: readonly BubbleWidgetScheduleEntry[]
}

export type WidgetEvent = {
  id: string
  title: string
  startsAt: string
  location?: string
  tasks: readonly PlanTask[]
  completedTaskIds?: readonly string[]
}

export type BubbleWidgetSelection = {
  snapshot: BubbleWidgetSnapshot
  thumbnail?: CapsuleImageSource
}

export type SelectBubbleWidgetInput = {
  now: Date
  theme: AppTheme
  privacy?: BubbleWidgetPrivacy
  events: readonly WidgetEvent[]
  /** Capsules fetched from the authenticated family service, never local cache. */
  authorizedCapsules: readonly FamilyCapsule[]
  viewedRecapIds?: ReadonlySet<string>
  allowContributionPrompt?: boolean
  /** Lets the timeline selector derive the prompt's 17:00–21:00 window. */
  contributionPromptsEnabled?: boolean
}

type EventAction = {
  event: WidgetEvent
  title: string
  task: boolean
}

/**
 * Selects one calm, useful widget card from already-authorized family data.
 * It deliberately returns media separately so it can never leak into the JSON
 * snapshot or a privacy-hidden widget.
 */
export function selectBubbleWidget(
  input: SelectBubbleWidgetInput,
): BubbleWidgetSelection {
  const now = input.now
  const nowMs = now.getTime()
  const privacy = input.privacy ?? 'hidden'
  const events = validFutureEvents(input.events, now)
  const todayActions = flattenActions(
    events.filter((event) => isSameLocalDay(new Date(event.startsAt), now)),
  )
  const urgentEvents = events.filter((event) => {
    const startsAt = new Date(event.startsAt).getTime()
    return startsAt >= nowMs && startsAt - nowMs <= twoHoursMs
  })
  const urgentActions = flattenActions(urgentEvents)
  const authorizedCapsules = input.authorizedCapsules
    .filter(isServiceAuthorizedCapsule)
  const nextRefreshAt = calculateNextRefreshAt(now, events, authorizedCapsules)
  const common = {
    version: 1 as const,
    generatedAt: now.toISOString(),
    ...(nextRefreshAt ? { nextRefreshAt } : {}),
    theme: input.theme,
    privacy,
  }

  if (urgentActions.length > 0) {
    const action = urgentActions[0]
    const remainingCount = remainingActionCount(action, todayActions, urgentActions)
    return protectSelection({
      snapshot: {
        ...common,
        kind: 'urgent',
        eyebrow: action.task ? 'Due soon' : 'Coming up',
        title: action.title,
        subtitle: eventSubtitle(action.event, action.task),
        ...(remainingCount > 0 ? { badge: `+${remainingCount}` } : {}),
        route: '/journal?section=plans',
      },
    })
  }

  const newlyOpened = authorizedCapsules
    .filter((capsule) => {
      const openedAt = validDate(capsule.opensAt)
      return openedAt !== null
        && openedAt.getTime() <= nowMs
        && isSameLocalDay(openedAt, now)
        && !input.viewedRecapIds?.has(capsule.id)
    })
    .sort((left, right) => dateMs(right.opensAt) - dateMs(left.opensAt))[0]
  if (newlyOpened) {
    const photo = latestPhoto(newlyOpened.photos)
    return protectSelection({
      snapshot: {
        ...common,
        kind: 'unlock',
        eyebrow: 'Capsule opened',
        title: `${newlyOpened.title} is ready`,
        subtitle: 'Open it together',
        route: `/capsule?recap=${encodeURIComponent(newlyOpened.id)}&source=widget`,
      },
      ...(photo ? { thumbnail: photo.thumbnail } : {}),
    })
  }

  if (todayActions.length > 0) {
    const action = todayActions[0]
    return protectSelection({
      snapshot: {
        ...common,
        kind: 'today',
        eyebrow: action.task ? 'Today’s task' : 'Today',
        title: action.title,
        subtitle: eventSubtitle(action.event, action.task),
        ...(todayActions.length > 1
          ? { badge: `+${todayActions.length - 1}` }
          : {}),
        route: '/journal?section=plans',
      },
    })
  }

  const allowContributionPrompt = input.contributionPromptsEnabled
    ? isSelectiveContributionWindow(now)
    : input.allowContributionPrompt
  const collectingCapsule = allowContributionPrompt
    ? authorizedCapsules
      .filter((capsule) => {
        const closesAt = dateMs(capsule.closesAt)
        const opensAt = dateMs(capsule.opensAt)
        return closesAt > nowMs
          && opensAt > nowMs
          && !capsule.photos.some((photo) => photo.ownedByCurrentUser)
      })
      .sort((left, right) => dateMs(left.closesAt) - dateMs(right.closesAt))[0]
    : undefined
  if (collectingCapsule) {
    return protectSelection({
      snapshot: {
        ...common,
        kind: 'capture',
        eyebrow: 'This week',
        title: 'A little moment?',
        subtitle: 'Add a photo to the family Capsule',
        route: `/capsule?contribute=${encodeURIComponent(collectingCapsule.id)}`,
      },
    })
  }

  const memoryCapsule = authorizedCapsules
    .filter((capsule) => (
      capsule.kind === 'weekly'
      && dateMs(capsule.opensAt) <= nowMs
      && representsImmediatelyPreviousLocalWeek(capsule, now)
      && latestPhoto(capsule.photos) !== undefined
    ))
    .sort((left, right) => dateMs(right.opensAt) - dateMs(left.opensAt))[0]
  const memoryPhoto = memoryCapsule ? latestPhoto(memoryCapsule.photos) : undefined
  if (memoryCapsule && memoryPhoto) {
    const caption = memoryPhoto.caption.trim()
    return protectSelection({
      snapshot: {
        ...common,
        kind: 'memory',
        eyebrow: 'From your family',
        title: caption || memoryCapsule.title,
        subtitle: memoryPhoto.contributorName
          ? `Shared by ${memoryPhoto.contributorName}`
          : 'A memory worth keeping',
        route: `/journal/photo/${encodeURIComponent(memoryCapsule.id)}/${encodeURIComponent(memoryPhoto.id)}`,
      },
      thumbnail: memoryPhoto.thumbnail,
    })
  }

  return protectSelection({
    snapshot: {
      ...common,
      kind: 'empty',
      eyebrow: 'Bubble',
      title: 'Nothing pressing today',
      subtitle: 'Open Bubble when a little moment finds you',
      route: '/',
    },
  })
}

/**
 * Publishes the current card plus same-day state transitions native widgets
 * can apply without waking the authenticated web app. Scheduled cards never
 * carry media; an unlocked poster is republished only when the app next runs.
 */
export function selectBubbleWidgetTimeline(
  input: SelectBubbleWidgetInput,
): BubbleWidgetSelection {
  const current = selectBubbleWidget(input)
  const schedule: BubbleWidgetScheduleEntry[] = []
  let previous = widgetCard(current.snapshot)

  for (const effectiveAtMs of sameDayTransitionTimes(input)) {
    if (schedule.length >= maxScheduledTransitions) break
    const future = selectBubbleWidget({
      ...input,
      // Cross the boundary so event-start and prompt-close transitions have
      // their post-boundary state at the exact native timeline date.
      now: new Date(effectiveAtMs + 1),
    })
    const next = widgetCard(future.snapshot)
    if (sameWidgetCard(previous, next)) continue
    const candidate = {
      effectiveAt: new Date(effectiveAtMs).toISOString(),
      ...next,
    }
    if (new TextEncoder().encode(
      JSON.stringify([...schedule, candidate]),
    ).byteLength > maxScheduledBytes) break
    schedule.push(candidate)
    previous = next
  }

  return {
    ...current,
    snapshot: {
      ...current.snapshot,
      ...(schedule.length > 0 ? { schedule } : {}),
    },
  }
}

/** Limits contribution nudges to a short early-evening window. */
export function isSelectiveContributionWindow(now: Date) {
  const hour = now.getHours()
  return hour >= 17 && hour < 21
}

/** Replaces sensitive copy and media while preserving the destination and kind. */
function protectSelection(selection: BubbleWidgetSelection): BubbleWidgetSelection {
  if (selection.snapshot.privacy === 'full') return selection

  const hiddenCopy: Record<BubbleWidgetKind, { eyebrow: string; title: string }> = {
    urgent: { eyebrow: 'Bubble', title: 'Something is coming up' },
    unlock: { eyebrow: 'Bubble', title: 'A Capsule is ready' },
    today: { eyebrow: 'Bubble', title: 'You have something today' },
    capture: { eyebrow: 'Bubble', title: 'A little moment?' },
    memory: { eyebrow: 'Bubble', title: 'A family memory' },
    empty: { eyebrow: 'Bubble', title: 'Nothing pressing today' },
  }
  const copy = hiddenCopy[selection.snapshot.kind]
  const snapshot: BubbleWidgetSnapshot = {
    ...selection.snapshot,
    eyebrow: copy.eyebrow,
    title: copy.title,
    subtitle: 'Open Bubble to see details',
  }
  delete snapshot.badge
  return {
    snapshot,
  }
}

function validFutureEvents(events: readonly WidgetEvent[], now: Date) {
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime()
  return events
    .filter((event) => {
      const startsAt = dateMs(event.startsAt)
      return Number.isFinite(startsAt)
        && startsAt >= startOfToday
        && event.title.trim().length > 0
    })
    .sort((left, right) => dateMs(left.startsAt) - dateMs(right.startsAt))
}

function flattenActions(events: readonly WidgetEvent[]): EventAction[] {
  return events.flatMap<EventAction>((event) => {
    const completed = new Set(event.completedTaskIds ?? [])
    const tasks = event.tasks.filter((task) => !completed.has(task.id))
    if (tasks.length === 0) {
      return event.tasks.length === 0
        ? [{ event, title: event.title.trim(), task: false }]
        : []
    }
    return tasks.map((task) => ({
      event,
      title: task.label.trim(),
      task: true,
    }))
  })
}

function remainingActionCount(
  selected: EventAction,
  todayActions: readonly EventAction[],
  urgentActions: readonly EventAction[],
) {
  const pool = todayActions.some((action) => sameAction(action, selected))
    ? todayActions
    : urgentActions
  return Math.max(0, pool.length - 1)
}

function sameAction(left: EventAction, right: EventAction) {
  return left.event.id === right.event.id
    && left.title === right.title
    && left.task === right.task
}

function eventSubtitle(event: WidgetEvent, selectedTask: boolean) {
  const startsAt = new Date(event.startsAt)
  const time = new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(startsAt)
  const context = selectedTask ? event.title.trim() : event.location?.trim()
  return context ? `${time} · ${context}` : time
}

function isServiceAuthorizedCapsule(capsule: FamilyCapsule) {
  return capsule.familySynced === true
    && validDate(capsule.opensAt) !== null
    && validDate(capsule.closesAt) !== null
}

function latestPhoto(photos: readonly CapsulePhoto[]) {
  return [...photos]
    .filter((photo) => (
      photo.syncStatus === 'synced'
      && validDate(photo.capturedAt) !== null
    ))
    .sort((left, right) => dateMs(right.capturedAt) - dateMs(left.capturedAt))[0]
}

function representsImmediatelyPreviousLocalWeek(
  capsule: FamilyCapsule,
  now: Date,
) {
  const currentWeekStart = startOfCapsuleWeek(now)
  const previousWeekStart = addLocalDays(currentWeekStart, -7)
  if (capsule.weekStart) {
    return capsule.weekStart === toLocalDateInput(previousWeekStart)
  }
  const opensAt = validDate(capsule.opensAt)
  return opensAt !== null && isSameLocalDay(opensAt, currentWeekStart)
}

function calculateNextRefreshAt(
  now: Date,
  events: readonly WidgetEvent[],
  capsules: readonly FamilyCapsule[],
) {
  const nowMs = now.getTime()
  const nextDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  ).getTime()
  const contributionWindowStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    17,
  ).getTime()
  const contributionWindowEnd = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    21,
  ).getTime()
  const candidates = [nextDay]

  if (contributionWindowStart > nowMs) {
    candidates.push(contributionWindowStart)
  }
  if (contributionWindowEnd > nowMs) {
    candidates.push(contributionWindowEnd)
  }

  events.forEach((event) => {
    const startsAt = dateMs(event.startsAt)
    if (startsAt > nowMs) candidates.push(startsAt)
    if (startsAt - twoHoursMs > nowMs) candidates.push(startsAt - twoHoursMs)
  })
  capsules.forEach((capsule) => {
    const opensAt = dateMs(capsule.opensAt)
    const closesAt = dateMs(capsule.closesAt)
    if (opensAt > nowMs) candidates.push(opensAt)
    if (closesAt > nowMs) candidates.push(closesAt)
  })

  const next = Math.min(...candidates.filter(Number.isFinite))
  return Number.isFinite(next) ? new Date(next).toISOString() : undefined
}

function sameDayTransitionTimes(input: SelectBubbleWidgetInput) {
  const nowMs = input.now.getTime()
  const nextDayMs = nextLocalMidnight(input.now).getTime()
  const candidates = new Set<number>([
    new Date(
      input.now.getFullYear(),
      input.now.getMonth(),
      input.now.getDate(),
      17,
    ).getTime(),
    new Date(
      input.now.getFullYear(),
      input.now.getMonth(),
      input.now.getDate(),
      21,
    ).getTime(),
  ])

  validFutureEvents(input.events, input.now).forEach((event) => {
    const startsAt = dateMs(event.startsAt)
    candidates.add(startsAt - twoHoursMs)
    candidates.add(startsAt)
  })
  input.authorizedCapsules
    .filter(isServiceAuthorizedCapsule)
    .forEach((capsule) => {
      candidates.add(dateMs(capsule.opensAt))
      candidates.add(dateMs(capsule.closesAt))
    })

  return [...candidates]
    .filter((candidate) => (
      Number.isFinite(candidate)
      && candidate > nowMs
      && candidate < nextDayMs
    ))
    .sort((left, right) => left - right)
}

function widgetCard(snapshot: BubbleWidgetSnapshot): BubbleWidgetCard {
  return {
    kind: snapshot.kind,
    theme: snapshot.theme,
    eyebrow: snapshot.eyebrow,
    title: snapshot.title,
    ...(snapshot.subtitle ? { subtitle: snapshot.subtitle } : {}),
    ...(snapshot.badge ? { badge: snapshot.badge } : {}),
    route: snapshot.route,
    privacy: snapshot.privacy,
  }
}

function sameWidgetCard(left: BubbleWidgetCard, right: BubbleWidgetCard) {
  return left.kind === right.kind
    && left.theme === right.theme
    && left.eyebrow === right.eyebrow
    && left.title === right.title
    && left.subtitle === right.subtitle
    && left.badge === right.badge
    && left.route === right.route
    && left.privacy === right.privacy
}

function nextLocalMidnight(now: Date) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
}

function isSameLocalDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

function validDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function dateMs(value: string) {
  return validDate(value)?.getTime() ?? Number.POSITIVE_INFINITY
}
