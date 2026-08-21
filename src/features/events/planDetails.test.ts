import { describe, expect, it } from 'vitest'

import { decodePlanDetails, encodePlanDetails } from './planDetails'

describe('planDetails', () => {
  it('keeps category-only plan details backward compatible', () => {
    expect(
      decodePlanDetails('kinsphere-plan-category:v1:wedding'),
    ).toEqual({ category: 'wedding', tasks: [] })
  })

  it('round-trips the doodle and shared task list in the v2 format', () => {
    const encoded = encodePlanDetails({
      category: 'other',
      doodle: 'fish',
      tasks: [
        { id: 'bring-snacks', label: ' Bring snacks ' },
        { id: 'pack-games', label: 'Pack games' },
      ],
    })

    expect(encoded).toMatch(/^kinsphere-plan:v2:/)
    expect(encoded.length).toBeLessThanOrEqual(2_000)
    expect(decodePlanDetails(encoded)).toEqual({
      category: 'other',
      doodle: 'fish',
      tasks: [
        { id: 'bring-snacks', label: 'Bring snacks' },
        { id: 'pack-games', label: 'Pack games' },
      ],
    })
  })

  it('rejects malformed, oversized, or excessive task payloads', () => {
    expect(decodePlanDetails('kinsphere-plan:v2:not-json')).toBeNull()
    expect(
      decodePlanDetails(
        `kinsphere-plan:v2:${JSON.stringify({
          category: 'other',
          doodle: 'scribble',
          tasks: [],
        })}`,
      ),
    ).toBeNull()
    expect(decodePlanDetails(`kinsphere-plan:v2:${'x'.repeat(2_001)}`)).toBeNull()

    expect(() => encodePlanDetails({
      category: 'other',
      doodle: 'sun',
      tasks: Array.from({ length: 13 }, (_, index) => ({
        id: `task-${index}`,
        label: `Task ${index}`,
      })),
    })).toThrow('up to 12 tasks')
  })

  it('rejects task labels that cannot fit the shared plan contract', () => {
    expect(() => encodePlanDetails({
      category: 'appointment',
      tasks: [{ id: 'task-1', label: 'x'.repeat(81) }],
    })).toThrow('unique id and label')
  })
})
