import { describe, expect, it } from 'vitest'
import { emptyPeopleTimelineState } from './peopleTimelineStore'
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

  it('includes a Family photo only for two distinct enrolled people', () => {
    const photos = [photo('solo'), photo('with-unenrolled'), photo('group'), photo('unknown')]
    const membership = new Map([
      ['solo', new Set(['mum', 'mum'])],
      ['with-unenrolled', new Set(['mum', 'guest'])],
      ['group', new Set(['mum', 'dad', 'guest'])],
    ])
    expect(selectFamilyPhotoKeys(photos, membership, new Set(['mum', 'dad'])))
      .toEqual(new Set(['group']))
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
