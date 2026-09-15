import { describe, expect, it } from 'vitest'
import { emptyPeopleTimelineState } from './peopleTimelineStore'
import { attachImportedPhotosToPerson } from './personPhotoImport'

function state() {
  return {
    ...emptyPeopleTimelineState(),
    people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
  }
}

describe('attachImportedPhotosToPerson', () => {
  it('adds exact unique photo membership without training faces or touching original gallery references', () => {
    const before = state()
    before.assignments = [{ photoKey: 'journal-photo:group', personId: 'leena', source: 'manual', confirmedAt: '2026-01-01' }]
    const after = attachImportedPhotosToPerson(before, 'maya', ['group', 'new', 'new', ''], '2026-09-15')
    expect(after.assignments).toEqual([
      before.assignments[0],
      { photoKey: 'journal-photo:group', personId: 'maya', source: 'manual', confirmedAt: '2026-09-15' },
      { photoKey: 'journal-photo:new', personId: 'maya', source: 'manual', confirmedAt: '2026-09-15' },
    ])
    expect(after.faceProfiles).toBe(before.faceProfiles)
    expect(after.faceScans).toBe(before.faceScans)
    expect(after.dismissedSuggestions).toBe(before.dismissedSuggestions)
    expect(after.assignments.every((assignment) => !assignment.faceId)).toBe(true)
    expect(before.assignments).toHaveLength(1)
  })

  it('reuses an existing row and keeps repeated association idempotent', () => {
    const first = attachImportedPhotosToPerson(state(), 'maya', ['existing'])
    expect(attachImportedPhotosToPerson(first, 'maya', ['existing', 'existing'])).toBe(first)
  })

  it('does not recreate a removed person or add phantom rows from an empty result', () => {
    const before = state()
    expect(attachImportedPhotosToPerson(before, 'removed', ['photo'])).toBe(before)
    expect(attachImportedPhotosToPerson(before, 'maya', [])).toBe(before)
  })
})
