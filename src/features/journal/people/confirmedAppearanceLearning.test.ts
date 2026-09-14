import { describe, expect, it } from 'vitest'
import { createFaceSuggestions } from './peopleTimelineHelpers'
import { emptyPeopleTimelineState } from './peopleTimelineStore'
import type {
  FaceReference,
  PeopleTimelineState,
  StoredFaceDetection,
} from './types'

const vector = (value: number) => Array<number>(1_024).fill(value)

function reference(
  id: string,
  value: number,
  overrides: Partial<FaceReference> = {},
): FaceReference {
  return {
    id,
    embedding: vector(value),
    quality: 0.9,
    source: 'enrollment',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function face(value: number, id = 'face-1'): StoredFaceDetection {
  return {
    id,
    embedding: vector(value),
    quality: 0.9,
    detectorScore: 0.95,
    descriptorScore: 0.95,
    minFacePixels: 128,
    box: [0.1, 0.1, 0.3, 0.3],
  }
}

function fixture(): PeopleTimelineState {
  const state = emptyPeopleTimelineState()
  state.people = [{ id: 'person', name: 'Person', createdAt: '2026-01-01T00:00:00.000Z' }]
  // Deliberately far from the later appearance used in these tests.
  state.faceProfiles.person = { references: [reference('original', 2)] }
  return state
}

function addScan(state: PeopleTimelineState, photoKey: string, detection: StoredFaceDetection) {
  state.faceScans[photoKey] = {
    scannedAt: '2026-09-14T00:00:00.000Z',
    faces: [detection],
  }
}

function confirmFace(
  state: PeopleTimelineState,
  photoKey: string,
  value: number,
  source: 'manual' | 'face-suggestion' = 'manual',
) {
  addScan(state, photoKey, face(value))
  state.assignments.push({
    photoKey,
    personId: 'person',
    faceId: 'face-1',
    source,
    confirmedAt: '2026-09-14T00:00:00.000Z',
  })
}

function candidateMatches(state: PeopleTimelineState, value: number) {
  addScan(state, 'candidate', face(value))
  return createFaceSuggestions(state).filter(({ photoKey }) => photoKey === 'candidate')
}

describe('explicitly confirmed appearance learning', () => {
  it('uses a high-quality face-level manual confirmation as a strict automatic anchor', () => {
    const state = fixture()
    confirmFace(state, 'confirmed-older-appearance', 3)

    expect(candidateMatches(state, 3)).toEqual([
      expect.objectContaining({
        photoKey: 'candidate',
        personId: 'person',
        confidence: 1,
      }),
    ])
  })

  it('does not promote an orphan manual-photo reference without matching manual provenance', () => {
    const state = fixture()
    state.faceProfiles.person?.references.push(reference('orphan', 3, {
      source: 'manual-photo',
      photoKey: 'unconfirmed-source',
      faceId: 'face-1',
    }))
    addScan(state, 'unconfirmed-source', face(3))

    expect(candidateMatches(state, 3)).toEqual([])
  })

  it('does not let an identical orphan vector swallow a later explicit confirmation', () => {
    const state = fixture()
    state.faceProfiles.person?.references.push(reference('orphan', 3, {
      source: 'manual-photo',
      photoKey: 'unconfirmed-source',
      faceId: 'face-1',
    }))
    addScan(state, 'unconfirmed-source', face(3))
    confirmFace(state, 'explicitly-confirmed-source', 3)

    expect(candidateMatches(state, 3)).toEqual([
      expect.objectContaining({ photoKey: 'candidate', personId: 'person' }),
    ])
  })

  it('does not let an identical unknown-quality enrollment swallow a trusted confirmation', () => {
    const state = fixture()
    state.faceProfiles.person = {
      references: [reference('legacy-enrollment', 3, { quality: undefined })],
    }
    confirmFace(state, 'explicitly-confirmed-source', 3)

    expect(candidateMatches(state, 3)).toEqual([
      expect.objectContaining({ photoKey: 'candidate', personId: 'person' }),
    ])
  })

  it('does not learn from a whole-photo tag or an inferred assignment', () => {
    const wholePhoto = fixture()
    addScan(wholePhoto, 'whole-photo', face(3))
    wholePhoto.assignments.push({
      photoKey: 'whole-photo',
      personId: 'person',
      source: 'manual',
      confirmedAt: '2026-09-14T00:00:00.000Z',
    })
    expect(candidateMatches(wholePhoto, 3)).toEqual([])

    const inferred = fixture()
    confirmFace(inferred, 'inferred-source', 3, 'face-suggestion')
    expect(candidateMatches(inferred, 3)).toEqual([])
  })

  it('excludes a rejected confirmed face from future automatic evidence', () => {
    const state = fixture()
    confirmFace(state, 'rejected-source', 3)
    state.dismissedSuggestions.push({
      photoKey: 'rejected-source',
      personId: 'person',
      faceId: 'face-1',
      dismissedAt: '2026-09-14T01:00:00.000Z',
    })

    expect(candidateMatches(state, 3)).toEqual([])
  })

  it.each([
    { newerConfirmations: 47, retained: true },
    { newerConfirmations: 63, retained: true },
    { newerConfirmations: 64, retained: false },
  ])(
    'keeps the newest 64 confirmed appearances (old anchor + $newerConfirmations newer)',
    ({ newerConfirmations, retained }) => {
      const state = fixture()
      confirmFace(state, 'old-confirmed-appearance', 3)
      for (let index = 0; index < newerConfirmations; index += 1) {
        confirmFace(state, `newer-confirmation-${index}`, 100 + index)
      }

      expect(candidateMatches(state, 3)).toHaveLength(retained ? 1 : 0)
    },
  )
})
