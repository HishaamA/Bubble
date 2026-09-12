import { describe, expect, it } from 'vitest'
import type { FamilyEventRecord } from '../events/eventService'
import { encodePlanDetails } from '../events/planDetails'
import { projectWidgetEvents } from './widgetEventProjection'
import type { WidgetEvent } from './widgetSnapshot'

function remote(id: string): FamilyEventRecord {
  return {
    id,
    title: `Plan ${id}`,
    startsAt: '2026-09-12T12:00:00+04:00',
    location: 'Home',
    details: encodePlanDetails({ category: 'other', tasks: [{ id: 'task', label: 'Bring cake' }] }),
  }
}

function local(id: string): WidgetEvent {
  return { ...remote(id), title: `Edited ${id}`, tasks: [{ id: 'local-task', label: 'Bring tea' }] }
}

function project(overrides: Partial<Parameters<typeof projectWidgetEvents>[0]> = {}) {
  return projectWidgetEvents({
    remoteEvents: [],
    localEvents: [],
    taskDefinitions: {},
    checklist: {},
    completedPlanIds: new Set(),
    ...overrides,
  })
}

describe('projectWidgetEvents', () => {
  it('decodes server tasks while omitting service-only details', () => {
    expect(project({ remoteEvents: [remote('a')] })).toEqual([{
      id: 'a', title: 'Plan a', startsAt: '2026-09-12T12:00:00+04:00', location: 'Home',
      tasks: [{ id: 'task', label: 'Bring cake' }], completedTaskIds: [],
    }])
  })

  it('lets pending local edits win without duplicating or reordering remote plans', () => {
    const events = project({
      remoteEvents: [remote('a'), remote('b')], localEvents: [local('b'), local('c')],
    })
    expect(events.map(({ id, title }) => [id, title])).toEqual([
      ['a', 'Plan a'], ['b', 'Edited b'], ['c', 'Edited c'],
    ])
    expect(events[1].tasks).toEqual([{ id: 'local-task', label: 'Bring tea' }])
  })

  it('removes completed plans from both sources', () => {
    expect(project({
      remoteEvents: [remote('a'), remote('b')], localEvents: [local('a'), local('c')],
      completedPlanIds: new Set(['a', 'c']),
    }).map(({ id }) => id)).toEqual(['b'])
  })

  it('honors an explicitly empty task override and account checklist values', () => {
    const events = project({
      remoteEvents: [remote('a')], localEvents: [local('b')],
      taskDefinitions: { a: [], b: [{ id: 'replacement', label: 'New task' }] },
      checklist: { a: ['task'], b: ['replacement'] },
    })
    expect(events[0].tasks).toEqual([])
    expect(events[0].completedTaskIds).toEqual(['task'])
    expect(events[1].tasks).toEqual([{ id: 'replacement', label: 'New task' }])
    expect(events[1].completedTaskIds).toEqual(['replacement'])
  })

  it('treats malformed remote details as an empty checklist', () => {
    expect(project({ remoteEvents: [{ ...remote('a'), details: 'not a plan' }] })[0].tasks).toEqual([])
  })

  it('does not mutate caller-owned plans, task definitions, or completion state', () => {
    const event = Object.freeze(remote('a'))
    const edit = Object.freeze({ ...local('b'), completedTaskIds: Object.freeze(['stale']) })
    const tasks = Object.freeze([{ id: 'replacement', label: 'New task' }])
    const input = Object.freeze({
      remoteEvents: Object.freeze([event]), localEvents: Object.freeze([edit]),
      taskDefinitions: Object.freeze({ a: tasks }), checklist: Object.freeze({}),
      completedPlanIds: new Set<string>(),
    })
    const first = projectWidgetEvents(input)
    expect(projectWidgetEvents(input)).toEqual(first)
    expect(first[1].completedTaskIds).toEqual([])
    expect(edit.completedTaskIds).toEqual(['stale'])
    expect(first[0].tasks).toBe(tasks)
  })
})
