import { describe, expect, it } from 'vitest'
import type { UnlockedCapsulePhoto } from '../capsuleJournalArchive'
import type { JournalPhoto } from '../journalPhotoTypes'
import {
  createFaceReviewCandidates,
  createFaceSuggestions,
  effectivePeopleForPhoto,
  faceResSimilarity,
  migrateLegacyPeopleTimelineState,
  sortTimelinePhotos,
  toPeopleTimelinePhotos,
} from './peopleTimelineHelpers'
import { emptyPeopleTimelineState } from './peopleTimelineStore'
import type {
  FaceReference,
  PeopleTimelinePhoto,
  PeopleTimelineState,
  StoredFaceDetection,
  TimelinePerson,
} from './types'

const DESCRIPTOR_LENGTH = 1_024

function timelinePhoto(key: string, capturedAt: string): PeopleTimelinePhoto {
  return {
    key,
    id: key,
    kind: 'capsule-photo',
    source: `/${key}-thumbnail.jpg`,
    scanSource: `/${key}-full.jpg`,
    capturedAt,
    caption: key,
    contributorName: 'Family',
    capsuleId: 'capsule',
    memoryId: `capsule-${key}`,
    canScanFaces: true,
  }
}

function person(id: string): TimelinePerson {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

// FaceRes emits 1024 non-negative activations. These deterministic fixtures
// have the same shape and value range while letting each test control the
// Euclidean distance exactly.
function faceResDescriptor(seed = 1) {
  let value = seed >>> 0
  return Array.from({ length: DESCRIPTOR_LENGTH }, () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0
    const unit = value / 0xffff_ffff
    return unit < 0.42 ? 0 : Number((unit * 1.9).toFixed(5))
  })
}

function shiftedDescriptor(base: readonly number[], delta: number) {
  return base.map((value) => Number((value + delta).toFixed(5)))
}

function detectedFace(
  id: string,
  embedding: number[],
  quality = 0.9,
): StoredFaceDetection {
  return {
    id,
    embedding,
    box: [0.1, 0.1, 0.3, 0.4],
    detectorScore: 0.95,
    descriptorScore: 0.94,
    quality,
  }
}

function enrollmentReference(
  id: string,
  embedding: number[],
  quality = 0.9,
): FaceReference {
  return {
    id,
    embedding,
    source: 'enrollment',
    createdAt: '2026-01-01T00:00:00.000Z',
    quality,
  }
}

function enroll(
  state: PeopleTimelineState,
  personId: string,
  ...embeddings: number[][]
) {
  state.faceProfiles[personId] = {
    references: embeddings.map((embedding, index) =>
      enrollmentReference(`${personId}-${index + 1}`, embedding),
    ),
  }
}

function addScan(
  state: PeopleTimelineState,
  photoKey: string,
  ...faces: StoredFaceDetection[]
) {
  state.faceScans[photoKey] = {
    scannedAt: '2026-01-02T00:00:00.000Z',
    faces,
  }
}

describe('people timeline helpers', () => {
  it('displays the thumbnail while scanning the sanitized full image', () => {
    const fullImage = new Blob(['metadata-free full image'], { type: 'image/jpeg' })
    const thumbnail = new Blob(['thumbnail'], { type: 'image/jpeg' })
    const photo: UnlockedCapsulePhoto = {
      id: 'portrait',
      capsuleId: 'capsule-a',
      image: fullImage,
      thumbnail,
      width: 1920,
      height: 1080,
      thumbnailWidth: 480,
      thumbnailHeight: 270,
      caption: 'At the park',
      capturedAt: '2025-04-02T12:00:00.000Z',
      contributorName: 'Maya',
      ownedByCurrentUser: true,
      capsuleTitle: 'Spring weekend',
      capsuleOpensAt: '2025-04-03T12:00:00.000Z',
    }

    const [timelineEntry] = toPeopleTimelinePhotos([photo])

    expect(timelineEntry).toMatchObject({
      key: 'photo:portrait',
      source: thumbnail,
      scanSource: fullImage,
      legacyKeys: ['capsule:capsule-a:portrait'],
    })
  })

  it('keeps direct Journal uploads distinct from Capsule photos', () => {
    const image = new Blob(['full'], { type: 'image/jpeg' })
    const thumbnail = new Blob(['thumb'], { type: 'image/jpeg' })
    const directPhoto: JournalPhoto = {
      id: 'direct-portrait',
      image,
      thumbnail,
      width: 1200,
      height: 900,
      thumbnailWidth: 400,
      thumbnailHeight: 300,
      caption: 'Childhood portrait',
      capturedAt: '2010-03-04T12:00:00.000Z',
      contributorName: 'Maya',
      ownedByCurrentUser: true,
      syncStatus: 'pending',
    }

    const [timelineEntry] = toPeopleTimelinePhotos([], [directPhoto])

    expect(timelineEntry).toMatchObject({
      key: 'journal-photo:direct-portrait',
      kind: 'journal-photo',
      source: thumbnail,
      scanSource: image,
      capsuleId: 'family-photo-library',
      memoryId: 'journal-photo-direct-portrait',
    })
    expect(timelineEntry?.legacyKeys).toBeUndefined()
  })

  it('sorts oldest to newest and respects an approximate year', () => {
    const photos = [
      timelinePhoto('recent', '2025-04-02T12:00:00.000Z'),
      timelinePhoto('old', '2004-03-02T12:00:00.000Z'),
    ]

    expect(sortTimelinePhotos(photos, {}).map(({ key }) => key)).toEqual([
      'old',
      'recent',
    ])
    expect(sortTimelinePhotos(photos, {
      recent: { precision: 'year', value: '1998' },
    }).map(({ key }) => key)).toEqual(['recent', 'old'])
  })

  it('uses the FaceRes scaled Euclidean metric instead of raw cosine', () => {
    const base = faceResDescriptor()

    expect(faceResSimilarity(base, base)).toBe(1)
    expect(faceResSimilarity(base, shiftedDescriptor(base, 0.2))).toBe(0.8)
    expect(faceResSimilarity(base, shiftedDescriptor(base, 0.3))).toBe(0.53)
    expect(faceResSimilarity(base.slice(1), base)).toBe(-1)
  })

  it('requires explicit enrollment before any face can be suggested', () => {
    const base = faceResDescriptor()
    const state = emptyPeopleTimelineState()
    state.people = [person('maya')]
    state.assignments = [{
      photoKey: 'manual-portrait',
      personId: 'maya',
      faceId: 'face-1',
      source: 'manual',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    }]
    addScan(state, 'manual-portrait', detectedFace('face-1', base))
    addScan(state, 'candidate', detectedFace('face-1', base))

    expect(createFaceSuggestions(state)).toEqual([])
  })

  it('matches distinct faces only when person and face choices are mutual', () => {
    const maya = faceResDescriptor()
    const leena = shiftedDescriptor(maya, 0.8)
    const state = emptyPeopleTimelineState()
    state.people = [person('maya'), person('leena')]
    enroll(state, 'maya', maya)
    enroll(state, 'leena', leena)
    addScan(
      state,
      'group-photo',
      detectedFace('face-1', shiftedDescriptor(maya, 0.2)),
      detectedFace('face-2', shiftedDescriptor(leena, 0.2)),
    )

    const suggestions = createFaceSuggestions(state)

    expect(suggestions).toHaveLength(2)
    expect(suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        photoKey: 'group-photo',
        faceId: 'face-1',
        personId: 'maya',
      }),
      expect.objectContaining({
        photoKey: 'group-photo',
        faceId: 'face-2',
        personId: 'leena',
      }),
    ]))
  })

  it('rejects both identity ambiguity and two faces competing for one person', () => {
    const maya = faceResDescriptor()
    const ambiguousIdentity = emptyPeopleTimelineState()
    ambiguousIdentity.people = [person('maya'), person('leena')]
    enroll(ambiguousIdentity, 'maya', maya)
    enroll(ambiguousIdentity, 'leena', shiftedDescriptor(maya, 0.4))
    addScan(
      ambiguousIdentity,
      'candidate',
      detectedFace('face-1', shiftedDescriptor(maya, 0.2)),
    )

    const duplicateIdentity = emptyPeopleTimelineState()
    duplicateIdentity.people = [person('maya')]
    enroll(duplicateIdentity, 'maya', maya)
    addScan(
      duplicateIdentity,
      'candidate',
      detectedFace('face-1', shiftedDescriptor(maya, 0.2)),
      detectedFace('face-2', shiftedDescriptor(maya, 0.205)),
    )

    expect(createFaceSuggestions(ambiguousIdentity)).toEqual([])
    expect(createFaceSuggestions(duplicateIdentity)).toEqual([])
  })

  it('uses multiple enrollment photos to cover another pose or age', () => {
    const primary = faceResDescriptor()
    const alternate = shiftedDescriptor(primary, 0.5)
    const state = emptyPeopleTimelineState()
    state.people = [person('maya')]
    enroll(state, 'maya', primary, alternate)
    addScan(
      state,
      'candidate',
      detectedFace('face-1', shiftedDescriptor(alternate, 0.22)),
    )

    expect(createFaceSuggestions(state)).toContainEqual(expect.objectContaining({
      photoKey: 'candidate',
      faceId: 'face-1',
      personId: 'maya',
    }))
  })

  it('learns a cross-age reference only from an explicitly confirmed face', () => {
    const primary = faceResDescriptor()
    const child = shiftedDescriptor(primary, 0.5)
    const state = emptyPeopleTimelineState()
    state.people = [person('maya')]
    enroll(state, 'maya', primary)
    state.assignments = [{
      photoKey: 'maya-as-a-child',
      personId: 'maya',
      faceId: 'face-2',
      source: 'manual',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    }]
    addScan(
      state,
      'maya-as-a-child',
      detectedFace('face-1', shiftedDescriptor(primary, 0.9)),
      detectedFace('face-2', child),
    )
    addScan(
      state,
      'candidate',
      detectedFace('face-1', shiftedDescriptor(child, 0.22)),
    )

    expect(createFaceSuggestions(state)).toContainEqual(expect.objectContaining({
      photoKey: 'candidate',
      faceId: 'face-1',
      personId: 'maya',
    }))
  })

  it('never learns from a whole-photo manual tag without a face id', () => {
    const primary = faceResDescriptor()
    const child = shiftedDescriptor(primary, 0.5)
    const state = emptyPeopleTimelineState()
    state.people = [person('maya')]
    enroll(state, 'maya', primary)
    state.assignments = [{
      photoKey: 'group-reference',
      personId: 'maya',
      source: 'manual',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    }]
    addScan(
      state,
      'group-reference',
      detectedFace('face-1', primary),
      detectedFace('face-2', child),
    )
    addScan(
      state,
      'candidate',
      detectedFace('face-1', shiftedDescriptor(child, 0.22)),
    )

    expect(createFaceSuggestions(state)).toEqual([])
  })

  it('routes medium-confidence and lower-quality faces to review', () => {
    const maya = faceResDescriptor()
    const state = emptyPeopleTimelineState()
    state.people = [person('maya')]
    enroll(state, 'maya', maya)
    addScan(
      state,
      'medium-match',
      detectedFace('face-1', shiftedDescriptor(maya, 0.3)),
    )
    addScan(
      state,
      'lower-quality-match',
      detectedFace('face-1', shiftedDescriptor(maya, 0.2), 0.36),
    )

    expect(createFaceSuggestions(state)).toEqual([])
    expect(createFaceReviewCandidates(state)).toEqual(expect.arrayContaining([
      expect.objectContaining({ photoKey: 'medium-match', faceId: 'face-1' }),
      expect.objectContaining({ photoKey: 'lower-quality-match', faceId: 'face-1' }),
    ]))
  })

  it('does not surface detections below the review quality floor', () => {
    const maya = faceResDescriptor()
    const state = emptyPeopleTimelineState()
    state.people = [person('maya')]
    enroll(state, 'maya', maya)
    addScan(
      state,
      'blurred-face',
      detectedFace('face-1', maya, 0.2),
    )

    expect(createFaceSuggestions(state)).toEqual([])
    expect(createFaceReviewCandidates(state)).toEqual([])
  })

  it('honors a dismissal for one face without hiding other decisions', () => {
    const maya = faceResDescriptor()
    const leena = shiftedDescriptor(maya, 0.8)
    const state = emptyPeopleTimelineState()
    state.people = [person('maya'), person('leena')]
    enroll(state, 'maya', maya)
    enroll(state, 'leena', leena)
    state.dismissedSuggestions = [{
      photoKey: 'photo:family',
      faceId: 'face-1',
      personId: 'maya',
      dismissedAt: '2026-01-02T00:00:00.000Z',
    }]
    addScan(
      state,
      'photo:family',
      detectedFace('face-1', shiftedDescriptor(maya, 0.2)),
      detectedFace('face-2', shiftedDescriptor(leena, 0.2)),
    )

    expect(createFaceSuggestions(state)).toEqual([
      expect.objectContaining({ faceId: 'face-2', personId: 'leena' }),
    ])
  })

  it('combines manual and automatic people while honoring face dismissals', () => {
    const state = emptyPeopleTimelineState()
    state.people = [person('maya'), person('leena'), person('omar')]
    state.assignments = [{
      photoKey: 'photo:family',
      personId: 'maya',
      faceId: 'face-1',
      source: 'manual',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    }]
    state.dismissedSuggestions = [{
      photoKey: 'photo:family',
      personId: 'leena',
      faceId: 'face-2',
      dismissedAt: '2026-01-02T00:00:00.000Z',
    }]

    expect(effectivePeopleForPhoto(state, 'photo:family', [
      { photoKey: 'photo:family', faceId: 'face-2', personId: 'leena', confidence: 0.99 },
      { photoKey: 'photo:family', faceId: 'face-3', personId: 'omar', confidence: 0.98 },
      { photoKey: 'photo:family', faceId: 'face-4', personId: 'unknown', confidence: 1 },
      { photoKey: 'photo:other', faceId: 'face-1', personId: 'leena', confidence: 1 },
    ])).toEqual(['maya', 'omar'])
  })

  it('migrates capsule-scoped keys in scans, decisions, and references', () => {
    const maya = faceResDescriptor()
    const state = emptyPeopleTimelineState()
    state.people = [person('maya')]
    state.assignments = [{
      photoKey: 'capsule:old-capsule:portrait',
      personId: 'maya',
      faceId: 'face-1',
      source: 'manual',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    }]
    addScan(
      state,
      'capsule:old-capsule:portrait',
      detectedFace('face-1', maya),
    )
    state.faceProfiles.maya = {
      references: [{
        ...enrollmentReference('maya-1', maya),
        source: 'manual-photo',
        photoKey: 'capsule:old-capsule:portrait',
        faceId: 'face-1',
      }],
    }
    state.dateOverrides = {
      'capsule:old-capsule:portrait': { precision: 'year', value: '2001' },
    }
    state.dismissedSuggestions = [{
      photoKey: 'capsule:old-capsule:portrait',
      personId: 'maya',
      faceId: 'face-1',
      dismissedAt: '2026-01-01T00:00:00.000Z',
    }]

    const migrated = migrateLegacyPeopleTimelineState(state, [
      { ...timelinePhoto('photo:portrait', '2025-04-02T12:00:00.000Z'), id: 'portrait' },
    ])

    expect(migrated.assignments[0]?.photoKey).toBe('photo:portrait')
    expect(migrated.faceScans['photo:portrait']?.faces[0]?.embedding).toEqual(maya)
    expect(migrated.faceProfiles.maya?.references[0]?.photoKey).toBe('photo:portrait')
    expect(migrated.dateOverrides['photo:portrait']?.value).toBe('2001')
    expect(migrated.dismissedSuggestions[0]?.photoKey).toBe('photo:portrait')
  })
})
