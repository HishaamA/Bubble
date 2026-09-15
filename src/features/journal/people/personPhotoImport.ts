import type { PeopleTimelineState } from './types'

/** Explicit scrapbook membership, not identity training or a label for every face. */
export function attachImportedPhotosToPerson(
  state: PeopleTimelineState,
  personId: string,
  photoIds: readonly string[],
  confirmedAt = new Date().toISOString(),
): PeopleTimelineState {
  if (!state.people.some((person) => person.id === personId)) return state
  const keys = new Set(photoIds.filter((id) => typeof id === 'string' && id.trim())
    .map((id) => `journal-photo:${id}`))
  const alreadyManual = new Set(state.assignments.filter((assignment) => (
    assignment.personId === personId && assignment.source === 'manual'
  )).map((assignment) => assignment.photoKey))
  const additions = [...keys].filter((key) => !alreadyManual.has(key))
    .map((photoKey) => ({ photoKey, personId, source: 'manual' as const, confirmedAt }))
  if (additions.length === 0) return state
  return { ...state, assignments: [...state.assignments, ...additions] }
}
