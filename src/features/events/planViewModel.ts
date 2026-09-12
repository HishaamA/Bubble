import type { FamilyEvent, PlanChecklistProgress, PlanTaskDefinitions } from './familyPlanTypes'
import type { PlanCategory, PlanDoodleName, PlanTask } from './planDetails'

export const planCategories = [
  { value: 'travel', label: 'Travel' },
  { value: 'graduation', label: 'Graduation' },
  { value: 'wedding', label: 'Wedding' },
  { value: 'anniversary', label: 'Anniversary' },
  { value: 'appointment', label: 'Important appointment' },
  { value: 'other', label: 'Other milestone' },
] as const

type UpcomingPlansInput = {
  demoPlans: readonly FamilyEvent[]
  createdEvents: readonly FamilyEvent[]
  sharedFamilyEvents: readonly FamilyEvent[]
  completedPlanIds: ReadonlySet<string>
  timelineOpenedAt: number
}

/** Shared rows win by ID; completion tombstones and the mount-day cutoff apply to every source. */
export function selectUpcomingPlans({
  demoPlans,
  createdEvents,
  sharedFamilyEvents,
  completedPlanIds,
  timelineOpenedAt,
}: UpcomingPlansInput): FamilyEvent[] {
  const eventsById = new Map<string, FamilyEvent>()
  for (const event of [...demoPlans, ...createdEvents, ...sharedFamilyEvents]) {
    if (completedPlanIds.has(event.id)) continue
    const startsAt = new Date(event.startsAt).getTime()
    if (
      !Number.isFinite(startsAt)
      || (!event.demoPresentation && event.date < localDateInputValue(new Date(timelineOpenedAt)))
    ) continue
    eventsById.set(event.id, event)
  }
  return [...eventsById.values()].sort(
    (left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime(),
  )
}

/** An explicitly empty override still replaces encoded or demo task definitions. */
export function tasksForPlan(event: FamilyEvent, definitions: PlanTaskDefinitions): PlanTask[] {
  return definitions[event.id] ?? event.tasks ?? event.demoPresentation?.checklist ?? []
}

/** An explicitly empty progress entry clears demo defaults rather than restoring them. */
export function completedTaskIdsForPlan(
  eventId: string,
  checklist: PlanTask[],
  progress: PlanChecklistProgress,
): Set<string> {
  return new Set(progress[eventId] ?? checklist.filter(taskStartsCompleted).map((item) => item.id))
}

/** Reads the demo-only initial completion marker without widening PlanTask. */
function taskStartsCompleted(
  task: PlanTask,
): task is PlanTask & { initiallyDone: true } {
  return 'initiallyDone' in task && task.initiallyDone === true
}

/** Selects stable artwork so a plan does not change decoration between renders. */
export function planDoodleForSeed(seed: string): PlanDoodleName {
  const doodles: PlanDoodleName[] = ['star', 'sun', 'fish', 'heart']
  const hash = [...seed].reduce(
    (current, character) => ((current * 31) + character.charCodeAt(0)) >>> 0,
    7,
  )
  return doodles[hash % doodles.length]
}

/** Maps stored category codes to human-readable card labels. */
export function planCategoryLabel(category: PlanCategory) {
  return (
    planCategories.find((item) => item.value === category)?.label
    ?? 'Milestone'
  )
}

/** Returns the Monday-through-Sunday local week containing an input date. */
export function planWeekForDate(value: string) {
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
export function formatPlanWeekRange(week: Date[]) {
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
export function formatPlanDay(value: string) {
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

/** Moves calendar selection by whole local days, with a safe invalid fallback. */
export function shiftPlanDay(value: string, days: number) {
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime())) return todayInputValue()
  date.setDate(date.getDate() + days)
  return localDateInputValue(date)
}

/** Serializes a Date for an HTML date field in device-local time. */
export function localDateInputValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Returns today's HTML date value in device-local time. */
export function todayInputValue() {
  return localDateInputValue(new Date())
}
