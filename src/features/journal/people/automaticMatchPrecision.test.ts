import { describe, expect, it } from 'vitest'
import { createFaceReviewCandidates, createFaceSuggestions, effectivePeopleForPhoto, faceResSimilarity } from './peopleTimelineHelpers'
import { emptyPeopleTimelineState } from './peopleTimelineStore'
import type { FaceReference, PeopleTimelineState, StoredFaceDetection } from './types'

const vector = (value: number) => Array<number>(1_024).fill(value)
const reference = (id: string, value: number, overrides: Partial<FaceReference> = {}): FaceReference => ({
  id, embedding: vector(value), quality: 0.9, source: 'enrollment', createdAt: '2026-01-01', ...overrides,
})
const face = (value: number, overrides: Partial<StoredFaceDetection> = {}): StoredFaceDetection => ({
  id: 'face-1', embedding: vector(value), quality: 0.9, detectorScore: 0.95, descriptorScore: 0.95,
  minFacePixels: 128, box: [0.1, 0.1, 0.3, 0.3], ...overrides,
})
function fixture(references = [reference('enrollment', 2)], detection = face(2)): PeopleTimelineState {
  return { ...emptyPeopleTimelineState(), people: [{ id: 'a', name: 'A', createdAt: '2026-01-01' }],
    faceProfiles: { a: { references } }, faceScans: { photo: { scannedAt: '2026-01-02', faces: [detection] } } }
}

describe('precision-first automatic albums', () => {
  it('requires near-exact evidence from a single trusted enrollment, not merely a relative winner', () => {
    const plausible = fixture(undefined, face(2.18))
    expect(faceResSimilarity(vector(2), vector(2.18))).toBe(0.85)
    expect(createFaceSuggestions(plausible)).toEqual([])
    expect(createFaceReviewCandidates(plausible)).toHaveLength(1)
    expect(createFaceSuggestions(fixture(undefined, face(2.15)))).toHaveLength(1)
  })

  it('accepts strong agreement with two independent trusted appearances', () => {
    const state = fixture([reference('first', 2), reference('second', 2.37)], face(2.1775))
    expect(faceResSimilarity(vector(2.1775), vector(2))).toBe(0.86)
    expect(faceResSimilarity(vector(2.1775), vector(2.37))).toBe(0.82)
    expect(createFaceSuggestions(state)).toEqual([
      expect.objectContaining({ photoKey: 'photo', personId: 'a', confidence: 0.86 }),
    ])
    expect(createFaceReviewCandidates(state)).toEqual([])
  })

  it.each([2, 2.05, 2.15])(
    'keeps cached decision scoring identical to public FaceRes scoring for %s',
    (candidateValue) => {
      const expected = faceResSimilarity(vector(candidateValue), vector(2))
      const state = fixture(undefined, face(candidateValue))

      expect(createFaceSuggestions(state)[0]?.confidence).toBe(expected)
      // Exercise the immutable prepared-vector and pair-score cache too.
      expect(createFaceSuggestions(state)[0]?.confidence).toBe(expected)
    },
  )

  it('keeps public similarity validation live for a caller-mutated vector', () => {
    const mutable = vector(2)
    expect(faceResSimilarity(mutable, vector(2))).toBe(1)
    mutable[0] = Number.NaN
    expect(faceResSimilarity(mutable, vector(2))).toBe(-1)
  })

  it.each(['duplicate', 'same-photo', 'weak-second', 'unknown-quality'])(
    'does not count %s evidence as independent automatic corroboration', (kind) => {
      const first = reference('first', 2, kind === 'same-photo' ? { photoKey: 'same' } : {})
      const second = reference('second', kind === 'duplicate' ? 2 : 2.37,
        kind === 'same-photo' ? { photoKey: 'same' }
          : kind === 'weak-second' ? { quality: 0.6 }
            : kind === 'unknown-quality' ? { quality: undefined } : {})
      const state = fixture([first, second], face(2.1775))
      expect(createFaceSuggestions(state)).toEqual([])
      expect(createFaceReviewCandidates(state)).toHaveLength(1)
    },
  )

  it('does not let an orphan manual-photo reference override the enrolled appearance', () => {
    const state = fixture([reference('enrolled', 2), reference('mistaken', 3, { source: 'manual-photo' })], face(3))
    expect(createFaceSuggestions(state)).toEqual([])
    expect(createFaceReviewCandidates(state)).toHaveLength(1)
    const weak = fixture([reference('enrolled', 2), reference('poor', 3, { quality: 0.4 })], face(3))
    expect(createFaceSuggestions(weak)).toEqual([])
    expect(createFaceReviewCandidates(weak)).toEqual([])
  })

  it('keeps unknown-quality legacy enrollment available for review without calling it certain', () => {
    const state = fixture([reference('legacy', 2, { quality: undefined })])
    expect(createFaceSuggestions(state)).toEqual([])
    expect(createFaceReviewCandidates(state)).toHaveLength(1)
  })

  it('stops using a previously stored learned appearance after its person label is rejected', () => {
    const state = fixture([reference('enrollment', 2),
      reference('stored-learning', 3, { source: 'manual-photo', photoKey: 'wrong-reference', faceId: 'face-1' })], face(3))
    expect(createFaceReviewCandidates(state)).toHaveLength(1)
    const profiles = state.faceProfiles
    state.dismissedSuggestions = [{ photoKey: 'wrong-reference', personId: 'a', faceId: 'face-1', dismissedAt: '2026-01-03' }]
    expect(createFaceSuggestions(state)).toEqual([])
    expect(createFaceReviewCandidates(state)).toEqual([])
    expect(state.faceProfiles).toBe(profiles)
  })

  it.each([
    { size: 0, review: 0, automatic: 0 },
    { size: 20, review: 0, automatic: 0 },
    { size: 47, review: 0, automatic: 0 },
    { size: 48, review: 1, automatic: 0 },
    { size: 79, review: 1, automatic: 0 },
    { size: 80, review: 0, automatic: 1 },
    { size: Number.NaN, review: 0, automatic: 0 },
  ])('requires enough real face detail at $size pixels', ({ size, review, automatic }) => {
    const state = fixture(undefined, face(2, { minFacePixels: size }))
    expect(createFaceSuggestions(state)).toHaveLength(automatic)
    expect(createFaceReviewCandidates(state)).toHaveLength(review)
  })

  it('does not confuse high detection confidence with detail in legacy scans', () => {
    const state = fixture(undefined, face(2, { minFacePixels: undefined, quality: 0.74875 }))
    expect(createFaceSuggestions(state)).toEqual([])
    expect(createFaceReviewCandidates(state)).toEqual([])
    const detailed = fixture(undefined, face(2, { minFacePixels: undefined }))
    expect(createFaceSuggestions(detailed)).toHaveLength(1)
  })

  it.each(['detectorScore', 'descriptorScore'] as const)('requires reliable %s independently of similarity', (score) => {
    expect(createFaceSuggestions(fixture(undefined, face(2, { [score]: 0.74 })))).toEqual([])
  })

  it('rejects degenerate or wrong-model vectors instead of treating them as identical identities', () => {
    for (const embedding of [vector(0), Array<number>(64).fill(2), new Array<number>(1024)]) {
      expect(faceResSimilarity(embedding, embedding)).toBe(-1)
      const state = fixture([reference('invalid', 2, { embedding })], face(2, { embedding }))
      expect(createFaceSuggestions(state)).toEqual([])
      expect(createFaceReviewCandidates(state)).toEqual([])
    }
  })

  it('rechecks legacy automatic assignments under current evidence without modifying them', () => {
    const state = fixture(undefined, face(2.25))
    state.assignments = [{ photoKey: 'photo', personId: 'a', faceId: 'face-1', source: 'face-suggestion', confirmedAt: '2026-01-03' }]
    const before = structuredClone(state)
    expect(createFaceSuggestions(state)).toEqual([])
    expect(effectivePeopleForPhoto(state, 'photo')).toEqual([])
    expect(state).toEqual(before)
    state.faceScans.photo.faces = [face(2)]
    expect(createFaceSuggestions(state)).toHaveLength(1)
    expect(effectivePeopleForPhoto(state, 'photo')).toEqual(['a'])
    state.faceScans.photo.faces = [face(2.25)]
    state.assignments[0].source = 'manual'
    expect(effectivePeopleForPhoto(state, 'photo')).toEqual(['a'])
  })

  it.each([false, true])('keeps a manually confirmed identity in the competing evidence (face-specific: %s)', (faceSpecific) => {
    const state = fixture()
    state.people.push({ id: 'b', name: 'B', createdAt: '2026-01-01' })
    state.faceProfiles.b = { references: [reference('b-enrollment', 2.15)] }
    state.assignments = [{ photoKey: 'photo', personId: 'a', source: 'manual',
      ...(faceSpecific ? { faceId: 'face-1' } : {}), confirmedAt: '2026-01-03' }]
    if (faceSpecific) state.faceScans.photo.faces.push(face(2.01, { id: 'face-2' }))
    expect(createFaceSuggestions(state)).toEqual([])
    expect(createFaceReviewCandidates(state)).toEqual([])
    expect(effectivePeopleForPhoto(state, 'photo')).toEqual(['a'])
  })

  it('requires stronger separation between relatives even for a high absolute score', () => {
    const state = fixture(undefined, face(2.15))
    state.people.push({ id: 'b', name: 'B', createdAt: '2026-01-01' })
    state.faceProfiles.b = { references: [reference('b-enrollment', 2.32)] }
    expect(faceResSimilarity(vector(2.15), vector(2))).toBe(0.93)
    expect(faceResSimilarity(vector(2.15), vector(2.32))).toBe(0.88)
    expect(createFaceSuggestions(state)).toEqual([])
    expect(createFaceReviewCandidates(state)).toEqual([expect.objectContaining({ personId: 'a' })])
  })
})
