import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DemoPlanPresentation, FamilyEvent } from './familyPlanTypes'
import {
  completedTaskIdsForPlan,
  formatPlanDay,
  formatPlanWeekRange,
  localDateInputValue,
  planCategoryLabel,
  planDoodleForSeed,
  planWeekForDate,
  selectUpcomingPlans,
  shiftPlanDay,
  tasksForPlan,
  todayInputValue,
} from './planViewModel'

const anchor = new Date(2026, 8, 12, 12)
const demo: DemoPlanPresentation = {
  attendees: [], additionalAttendees: 0, doodle: 'heart', timeStyle: 'time-location',
  checklist: [{ id: 'demo-task', label: 'Bring dessert', initiallyDone: true }],
}

function plan(overrides: Partial<FamilyEvent> = {}): FamilyEvent {
  return {
    id: 'plan-one', title: 'Family picnic', date: '2026-09-12', time: '09:00',
    location: 'Park', category: 'other', startsAt: new Date(2026, 8, 12, 9).toISOString(),
    ...overrides,
  }
}

function select(overrides: Partial<Parameters<typeof selectUpcomingPlans>[0]> = {}) {
  return selectUpcomingPlans({
    demoPlans: [], createdEvents: [], sharedFamilyEvents: [], completedPlanIds: new Set(),
    timelineOpenedAt: anchor.getTime(), ...overrides,
  })
}

afterEach(() => vi.useRealTimers())

describe('plan view model', () => {
  it('lets family rows override local and demo rows with the same ID without mutating inputs', () => {
    const preview = plan({ title: 'Preview', demoPresentation: demo })
    const local = plan({ title: 'Local draft' })
    const remote = plan({ title: 'Family version' })
    const createdEvents = [local]
    expect(select({ demoPlans: [preview], createdEvents, sharedFamilyEvents: [remote] })).toEqual([remote])
    expect(createdEvents).toEqual([local])
    expect(local.title).toBe('Local draft')
  })

  it('keeps completion tombstones authoritative over all stale sources', () => {
    expect(select({
      demoPlans: [plan({ demoPresentation: demo })], createdEvents: [plan()],
      sharedFamilyEvents: [plan()], completedPlanIds: new Set(['plan-one']),
    })).toEqual([])
  })

  it('filters by the mounted local day, not the current clock time within that day', () => {
    const yesterday = plan({ id: 'yesterday', date: '2026-09-11', startsAt: new Date(2026, 8, 11, 23).toISOString() })
    const earlierToday = plan()
    const tomorrow = plan({ id: 'tomorrow', date: '2026-09-13', startsAt: new Date(2026, 8, 13, 9).toISOString() })
    expect(select({ createdEvents: [tomorrow, yesterday, earlierToday] })).toEqual([earlierToday, tomorrow])
  })

  it('retains earlier demo days while rejecting invalid timestamps from every source', () => {
    const earlierDemo = plan({ id: 'demo', date: '2026-09-10', startsAt: new Date(2026, 8, 10, 9).toISOString(), demoPresentation: demo })
    expect(select({
      demoPlans: [earlierDemo, plan({ id: 'invalid-demo', startsAt: 'invalid', demoPresentation: demo })],
      createdEvents: [plan({ id: 'invalid-local', startsAt: 'invalid' })],
      sharedFamilyEvents: [plan({ id: 'invalid-shared', startsAt: 'invalid' })],
    })).toEqual([earlierDemo])
  })

  it('does not let an invalid remote row overwrite a usable local row', () => {
    const local = plan()
    expect(select({ createdEvents: [local], sharedFamilyEvents: [plan({ startsAt: 'invalid' })] })).toEqual([local])
  })

  it('keeps stable source order for equal timestamps while replacing matching values', () => {
    const first = plan({ id: 'first' })
    const second = plan({ id: 'second' })
    const firstRemote = { ...first, title: 'Renamed' }
    expect(select({ createdEvents: [first, second], sharedFamilyEvents: [firstRemote] })).toEqual([firstRemote, second])
  })

  it('resolves task definitions in explicit override, encoded, then demo order', () => {
    const encoded = [{ id: 'encoded', label: 'Book a table' }]
    const override = [{ id: 'override', label: 'Bring cake' }]
    const event = plan({ tasks: encoded, demoPresentation: demo })
    expect(tasksForPlan(event, { [event.id]: override })).toBe(override)
    expect(tasksForPlan(event, {})).toBe(encoded)
    expect(tasksForPlan(plan({ demoPresentation: demo }), {})).toBe(demo.checklist)
    expect(tasksForPlan(plan(), {})).toEqual([])
  })

  it('honors empty task and checklist overrides instead of restoring demo defaults', () => {
    const event = plan({ demoPresentation: demo })
    expect(tasksForPlan(event, { [event.id]: [] })).toEqual([])
    expect(tasksForPlan({ ...event, tasks: [] }, {})).toEqual([])
    expect([...completedTaskIdsForPlan(event.id, demo.checklist, {})]).toEqual(['demo-task'])
    expect([...completedTaskIdsForPlan(event.id, demo.checklist, { [event.id]: [] })]).toEqual([])
  })

  it('returns a fresh completion set without mutating persisted progress or task defaults', () => {
    const progress = { 'plan-one': ['saved-task'] }
    const selected = completedTaskIdsForPlan('plan-one', demo.checklist, progress)
    selected.add('new-task')
    expect(progress['plan-one']).toEqual(['saved-task'])
    expect(demo.checklist[0].initiallyDone).toBe(true)
  })

  it('builds a Monday-through-Sunday local week across year boundaries', () => {
    const week = planWeekForDate('2027-01-01')
    expect(week.map(localDateInputValue)).toEqual([
      '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31',
      '2027-01-01', '2027-01-02', '2027-01-03',
    ])
    expect(week.every((date) => date.getHours() === 12)).toBe(true)
    expect(formatPlanWeekRange(week)).toBe('Dec 28 – Jan 3')
    expect(formatPlanWeekRange([])).toBe('')
  })

  it('shifts whole local days over leap/month boundaries and falls back to today for invalid input', () => {
    vi.useFakeTimers().setSystemTime(anchor)
    expect(shiftPlanDay('2028-02-28', 1)).toBe('2028-02-29')
    expect(shiftPlanDay('2028-02-29', 1)).toBe('2028-03-01')
    expect(shiftPlanDay('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftPlanDay('invalid', 7)).toBe('2026-09-12')
    expect(todayInputValue()).toBe('2026-09-12')
    expect(formatPlanDay('invalid')).toBe('invalid')
    expect(formatPlanDay('2026-09-12')).toBe('Saturday, September 12')
  })

  it('keeps persisted category labels and deterministic notebook decorations stable', () => {
    expect(planCategoryLabel('appointment')).toBe('Important appointment')
    expect(planCategoryLabel('other')).toBe('Other milestone')
    expect(planDoodleForSeed('')).toBe('heart')
    expect(planDoodleForSeed('a')).toBe('fish')
    expect(planDoodleForSeed('Family picnic')).toBe(planDoodleForSeed('Family picnic'))
  })
})
