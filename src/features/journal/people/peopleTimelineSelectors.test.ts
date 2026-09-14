import { describe, expect, it } from 'vitest'
import { emptyPeopleTimelineState } from './peopleTimelineStore'
import { effectivePeopleForPhoto } from './peopleTimelineHelpers'
import {
  FACE_REVIEW_PERSON_ID,
  faceReviewKey,
  selectEffectivePeopleByPhoto,
  selectEnrolledPersonIds,
  selectFaceReviewPreviews,
  selectFamilyPhotoKeys,
  selectPeoplePhotoAlbums,
  selectVisibleTimelinePhotos,
} from './peopleTimelineSelectors'
import {
  ALL_PHOTOS_PERSON_ID,
  FAMILY_PERSON_ID,
  type FaceSuggestion,
  type PeopleTimelinePhoto,
  type PeopleTimelineState,
  type TimelinePerson,
} from './types'

const createdAt = '2026-01-01T12:00:00Z'
const person = (id: string): TimelinePerson => ({ id, name: id, createdAt })
const photo = (key: string, capturedAt = createdAt): PeopleTimelinePhoto => ({
  key, id: key, kind: 'journal-photo', source: `/${key}.jpg`, scanSource: `/${key}.jpg`,
  capturedAt, caption: key, contributorName: 'Family', capsuleId: 'family-photo-library',
  memoryId: key, canScanFaces: true,
})
const suggestion = (photoKey: string, personId = 'mum', faceId = 'face'): FaceSuggestion => ({
  photoKey, personId, faceId, confidence: 0.6,
})

describe('people timeline selectors', () => {
  it('indexes a 4,697-photo gallery without changing manual/dismissed match semantics', () => {
    const state = emptyPeopleTimelineState()
    state.people = [person('dad'), person('mum')]
    const photos = Array.from({ length: 4697 }, (_, index) => photo(`gallery-${index}`))
    const matches = photos.flatMap(({ key }, index) => [
      suggestion(key, index % 2 ? 'dad' : 'mum'),
      suggestion(key, 'deleted-person'),
    ])
    state.assignments = [{ photoKey: 'gallery-0', personId: 'dad', source: 'manual', confirmedAt: createdAt }]
    state.dismissedSuggestions = [
      { photoKey: 'gallery-0', personId: 'mum', faceId: 'face', dismissedAt: createdAt },
      { photoKey: 'gallery-1', personId: 'dad', dismissedAt: createdAt },
      { photoKey: 'gallery-2', personId: 'mum', faceId: 'different-face', dismissedAt: createdAt },
    ]
    const membership = selectEffectivePeopleByPhoto(state, photos, matches)
    expect(membership.size).toBe(4697)
    for (const item of [...photos.slice(0, 4), photos[4696]]) {
      expect([...membership.get(item.key)!]).toEqual(effectivePeopleForPhoto(state, item.key, matches))
    }
    expect(membership.get('gallery-0')).toEqual(new Set(['dad']))
    expect(membership.get('gallery-1')).toEqual(new Set())
    expect(membership.get('gallery-2')).toEqual(new Set(['mum']))
  })

  it('shares album covers and counts while preserving profile and source-photo order', () => {
    const people = [person('dad'), person('mum'), person('no-photos')]
    const photos = [photo('later', '2026-09-01T12:00:00Z'), photo('earlier')]
    const membership = new Map([
      ['later', new Set(['mum', 'dad', 'deleted-person'])],
      ['earlier', new Set(['mum'])],
    ])
    const result = selectPeoplePhotoAlbums(people, photos, membership)

    expect(result.albums.map(({ person: owner, photoCount }) => [owner.id, photoCount]))
      .toEqual([['dad', 1], ['mum', 2]])
    expect(result.albums[1].preview).toBe(photos[0])
    expect(result.previews.get('mum')).toBe(result.albums[1].preview)
    expect(result.previews.has('no-photos')).toBe(false)
    expect(result.previews.has('deleted-person')).toBe(false)
    expect(photos.map(({ key }) => key)).toEqual(['later', 'earlier'])
  })

  it('requires usable enrollment references, not merely a named profile', () => {
    expect(selectEnrolledPersonIds({
      mum: { references: [{ id: 'ref', embedding: [1], source: 'enrollment', createdAt }] },
      dad: { references: [] },
    })).toEqual(new Set(['mum']))
  })

  it('combines manual and automatic people while respecting dismissals and deleted profiles', () => {
    const state = emptyPeopleTimelineState()
    state.people = [person('mum'), person('dad')]
    state.assignments = [{
      photoKey: 'shared', personId: 'dad', source: 'manual', confirmedAt: createdAt,
    }]
    state.dismissedSuggestions = [{
      photoKey: 'shared', personId: 'mum', faceId: 'face', dismissedAt: createdAt,
    }]
    const result = selectEffectivePeopleByPhoto(state, [photo('shared'), photo('other')], [
      suggestion('shared'), suggestion('shared', 'deleted-person'), suggestion('other'),
    ])
    expect(result.get('shared')).toEqual(new Set(['dad']))
    expect(result.get('other')).toEqual(new Set(['mum']))
  })

  it('includes any two or more of four family members, not only the complete family', () => {
    const photos = [photo('solo'), photo('with-guest'), photo('pair'), photo('three'), photo('everyone'), photo('unknown')]
    const membership = new Map([
      ['solo', new Set(['mum', 'mum'])],
      ['with-guest', new Set(['mum', 'guest'])],
      ['pair', new Set(['mum', 'dad'])],
      ['three', new Set(['mum', 'child', 'gran'])],
      ['everyone', new Set(['mum', 'dad', 'child', 'gran', 'guest'])],
    ])
    expect(selectFamilyPhotoKeys(photos, membership, new Set(['mum', 'dad', 'child', 'gran'])))
      .toEqual(new Set(['pair', 'three', 'everyone']))
  })

  it('counts confirmed family tags even without any saved face profiles', () => {
    const state = emptyPeopleTimelineState()
    state.people = [person('mum'), person('dad'), person('child'), person('gran')]
    state.assignments = [
      { photoKey: 'pair', personId: 'mum', source: 'manual', confirmedAt: createdAt },
      { photoKey: 'pair', personId: 'dad', source: 'manual', confirmedAt: createdAt },
      { photoKey: 'solo', personId: 'mum', source: 'manual', confirmedAt: createdAt },
      { photoKey: 'solo', personId: 'dad', source: 'face-suggestion', confirmedAt: createdAt },
    ]
    const photos = [photo('pair'), photo('solo')]
    expect(selectEnrolledPersonIds(state.faceProfiles).size).toBe(0)
    const effective = selectEffectivePeopleByPhoto(state, photos, [])
    expect(selectFamilyPhotoKeys(photos, effective, new Set(state.people.map(({ id }) => id))))
      .toEqual(new Set(['pair']))
  })

  it('ignores stored inferred identities unless accepted by the current automatic matches', () => {
    const state = emptyPeopleTimelineState()
    state.people = [person('mum'), person('dad')]
    state.assignments = ['stale', 'rechecked', 'dismissed'].map((photoKey) => ({
      photoKey, personId: 'dad', faceId: 'old-face', source: 'face-suggestion', confirmedAt: createdAt,
    }))
    state.dismissedSuggestions = [{ photoKey: 'dismissed', personId: 'dad', dismissedAt: createdAt }]
    const originalAssignments = state.assignments.map((assignment) => ({ ...assignment }))
    const result = selectEffectivePeopleByPhoto(state, ['stale', 'rechecked', 'dismissed'].map((key) => photo(key)), [
      { ...suggestion('rechecked', 'mum', 'current-face'), confidence: 0.99 },
      { ...suggestion('dismissed', 'dad', 'current-face'), confidence: 0.99 },
    ])

    expect(result.get('stale')).toEqual(new Set())
    expect(result.get('rechecked')).toEqual(new Set(['mum']))
    expect(result.get('dismissed')).toEqual(new Set())
    // A read-time policy correction must not rewrite the user's stored state.
    expect(state.assignments).toEqual(originalAssignments)
  })

  it('preserves explicit manual decisions even without a live match or after a dismissed suggestion', () => {
    const state = emptyPeopleTimelineState()
    state.people = [person('mum'), person('dad')]
    state.assignments = [{
      photoKey: 'confirmed', personId: 'dad', faceId: 'confirmed-face', source: 'manual', confirmedAt: createdAt,
    }]
    state.dismissedSuggestions = [{ photoKey: 'confirmed', personId: 'dad', dismissedAt: createdAt }]

    expect(selectEffectivePeopleByPhoto(state, [photo('confirmed')], []).get('confirmed'))
      .toEqual(new Set(['dad']))
  })

  it('requires two accepted identities for Family, never a stale inferred second person', () => {
    const state = emptyPeopleTimelineState()
    state.people = [person('mum'), person('dad')]
    const photos = ['stale-second', 'current-second', 'both-manual', 'same-person-twice'].map((key) => photo(key))
    state.assignments = [
      ...photos.map(({ key: photoKey }) => ({
        photoKey, personId: 'dad', source: 'manual' as const, confirmedAt: createdAt,
      })),
      { photoKey: 'stale-second', personId: 'mum', source: 'face-suggestion', confirmedAt: createdAt },
      { photoKey: 'current-second', personId: 'mum', source: 'face-suggestion', confirmedAt: createdAt },
      { photoKey: 'both-manual', personId: 'mum', source: 'manual', confirmedAt: createdAt },
    ]
    const effective = selectEffectivePeopleByPhoto(state, photos, [
      { ...suggestion('current-second', 'mum'), confidence: 0.99 },
      { ...suggestion('same-person-twice', 'dad'), confidence: 0.99 },
    ])

    expect(effective.get('stale-second')).toEqual(new Set(['dad']))
    expect(selectFamilyPhotoKeys(photos, effective, new Set(['mum', 'dad'])))
      .toEqual(new Set(['current-second', 'both-manual']))
  })

  it('applies All, Family, person, and review filters using corrected timeline dates', () => {
    const photos = [photo('a'), photo('b', '2026-06-01T12:00:00Z'), photo('c', '2026-03-01T12:00:00Z')]
    const input = {
      photos,
      reviewMatches: [suggestion('c'), suggestion('c', 'dad')],
      effectivePeople: new Map([['a', new Set(['mum'])], ['b', new Set(['mum', 'dad'])]]),
      familyPhotoKeys: new Set(['b']),
      dateOverrides: { b: { precision: 'year' as const, value: '2020' } },
    }
    const keys = (selectedPersonId: string) => selectVisibleTimelinePhotos({ ...input, selectedPersonId })
      .map(({ key }) => key)
    expect(keys(ALL_PHOTOS_PERSON_ID)).toEqual(['b', 'a', 'c'])
    expect(keys(FAMILY_PERSON_ID)).toEqual(['b'])
    expect(keys('mum')).toEqual(['b', 'a'])
    expect(keys(FACE_REVIEW_PERSON_ID)).toEqual(['c'])
    expect(keys('missing')).toEqual([])
    expect(photos.map(({ key }) => key)).toEqual(['a', 'b', 'c'])
  })

  it('breaks equal-date ties by stable photo key, not network response order', () => {
    const result = selectVisibleTimelinePhotos({
      selectedPersonId: ALL_PHOTOS_PERSON_ID,
      photos: [photo('z'), photo('a')], reviewMatches: [], effectivePeople: new Map(),
      familyPhotoKeys: new Set(), dateOverrides: {},
    })
    expect(result.map(({ key }) => key)).toEqual(['a', 'z'])
  })

  it('builds three distinct valid face previews, skipping stale photo/person/face references', () => {
    const photos = ['a', 'b', 'c', 'd'].map((key) => photo(key))
    const scans: PeopleTimelineState['faceScans'] = Object.fromEntries(photos.map(({ key }) => [key, {
      scannedAt: createdAt,
      faces: [{ id: 'face', embedding: [], box: [0.1, 0.2, 0.2, 0.4], detectorScore: 1, descriptorScore: 1, quality: 1 }],
    }]))
    const matches = [
      suggestion('missing'), suggestion('a', 'missing'), suggestion('a', 'mum', 'missing'),
      suggestion('a'), suggestion('a', 'dad'), suggestion('b'), suggestion('c'), suggestion('d'),
    ]
    const previews = selectFaceReviewPreviews(matches, photos, [person('mum'), person('dad')], scans)
    expect(previews.map(({ photo: item }) => item.key)).toEqual(['a', 'b', 'c'])
    expect(previews[0].match).toBe(matches[3])
    expect(previews[0].faceCenter).toEqual([0.2, 0.4])
    expect(previews[0].faceScale).toBeCloseTo(1.75)
  })

  it('keeps postponed-review identity specific to photo, face, and person', () => {
    const keys = [suggestion('a'), suggestion('b'), suggestion('a', 'dad'), suggestion('a', 'mum', 'second')]
      .map(faceReviewKey)
    expect(new Set(keys).size).toBe(4)
  })

  it('returns empty models for an empty local library', () => {
    expect(selectPeoplePhotoAlbums([], [], new Map())).toEqual({ albums: [], previews: new Map() })
    expect(selectFaceReviewPreviews([], [], [], {})).toEqual([])
    expect(selectFamilyPhotoKeys([], new Map(), new Set())).toEqual(new Set())
  })
})
