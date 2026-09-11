import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventStorageKey } from '../events/eventStorage'
import {
  BUBBLE_WIDGET_DATA_CHANGED_EVENT,
  PLAN_CHECKLISTS_STORAGE_KEY,
  markWidgetRecapViewed,
  readViewedWidgetRecaps,
  readWidgetChecklistProgress,
  readWidgetLocalEvents,
  readWidgetPrivacy,
  writeWidgetPrivacy,
} from './widgetStorage'

describe('widgetStorage', () => {
  beforeEach(() => window.localStorage.clear())

  it('reads only bounded checklist IDs from the active family scope', () => {
    const key = eventStorageKey(PLAN_CHECKLISTS_STORAGE_KEY, 'user-a:family:a')
    window.localStorage.setItem(key, JSON.stringify({
      'event-1': ['task-1', 'task-1', 7, 'task-2'],
      ['x'.repeat(161)]: ['ignored'],
    }))

    expect(readWidgetChecklistProgress('user-a:family:a')).toEqual({
      'event-1': ['task-1', 'task-2'],
    })
    expect(readWidgetChecklistProgress('user-b:family:b')).toEqual({})
  })

  it('ignores malformed local plans rather than breaking publication', () => {
    window.localStorage.setItem(
      eventStorageKey('kinsphere-created-events', 'subject'),
      JSON.stringify([
        { id: 'bad', title: '', startsAt: 'not-a-date' },
        {
          id: 'good',
          title: 'Museum day',
          startsAt: new Date(2026, 8, 12, 10).toISOString(),
          location: 'The museum',
          tasks: [{ id: 'tickets', label: 'Buy tickets' }],
        },
      ]),
    )

    expect(readWidgetLocalEvents('subject')).toEqual([expect.objectContaining({
      id: 'good',
      title: 'Museum day',
      tasks: [{ id: 'tickets', label: 'Buy tickets' }],
    })])
  })

  it('marks a recap in scope and notifies the live publisher', () => {
    const listener = vi.fn()
    window.addEventListener(BUBBLE_WIDGET_DATA_CHANGED_EVENT, listener)

    expect(markWidgetRecapViewed('subject-a', 'capsule-1')).toBe(true)
    expect(readViewedWidgetRecaps('subject-a')).toEqual(new Set(['capsule-1']))
    expect(readViewedWidgetRecaps('subject-b')).toEqual(new Set())
    expect(listener).toHaveBeenCalledOnce()

    window.removeEventListener(BUBBLE_WIDGET_DATA_CHANGED_EVENT, listener)
  })

  it('keeps widget details hidden until the active family opts in', () => {
    expect(readWidgetPrivacy('subject-a')).toBe('hidden')
    expect(writeWidgetPrivacy('subject-a', 'full')).toBe(true)
    expect(readWidgetPrivacy('subject-a')).toBe('full')
    expect(readWidgetPrivacy('subject-b')).toBe('hidden')
    expect(writeWidgetPrivacy('subject-a', 'hidden')).toBe(true)
    expect(readWidgetPrivacy('subject-a')).toBe('hidden')
  })
})
