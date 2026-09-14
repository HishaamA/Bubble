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
  it('reuses progressive matching safely when a person gains a different reference', () => {
    const state = emptyPeopleTimelineState()
    state.people = [person('mum')]
    const original = faceResDescriptor(2)
    const older = faceResDescriptor(91)
    enroll(state, 'mum', original)
    addScan(state, 'recent', detectedFace('face-1', original))
    addScan(state, 'older', detectedFace('face-1', older))
    expect(createFaceSuggestions(state).map(({ photoKey }) => photoKey)).toEqual(['recent'])
    const improved = {
      ...state,
      faceProfiles: { mum: { references: [...state.faceProfiles.mum.references, enrollmentReference('older-ref', older)] } },
    }
    const matches = createFaceSuggestions(improved)
    expect(matches.map(({ photoKey }) => photoKey)).toEqual(['recent', 'older'])
    expect(createFaceReviewCandidates(improved, undefined, undefined, undefined, matches))
      .toEqual(createFaceReviewCandidates(improved))
    // Replacing the reference list must not retain a removed appearance match.
    expect(createFaceSuggestions({ ...improved, faceProfiles: { mum: { references: [enrollmentReference('older-only', older)] } } })
      .map(({ photoKey }) => photoKey)).toEqual(['older'])
  })

  it('deduplicates one upload across revealed Capsules with stable collection identity and offline media', () => {
    const image = new Blob(['offline full'], { type: 'image/jpeg' })
    const thumbnail = new Blob(['offline thumbnail'], { type: 'image/jpeg' })
    const weekly: UnlockedCapsulePhoto = {
      id: 'same-upload', capsuleId: 'z-weekly', image, thumbnail,
      width: 1200, height: 900, caption: 'Together', capturedAt: '2026-01-01T12:00:00.000Z',
      contributorName: 'Maya', ownedByCurrentUser: true, syncStatus: 'synced',
      capsuleTitle: 'Weekly Capsule', capsuleOpensAt: '2026-01-05T00:00:00.000Z',
    }
    const special: UnlockedCapsulePhoto = {
      ...weekly, capsuleId: 'a-special', capsuleTitle: 'Special Capsule',
      image: 'https://example.test/full.jpg', thumbnail: 'https://example.test/thumb.jpg',
    }
    const [entry] = toPeopleTimelinePhotos([weekly, special])
    expect(toPeopleTimelinePhotos([weekly, special])).toHaveLength(1)
    expect(toPeopleTimelinePhotos([special, weekly])).toEqual([entry])
    expect(entry).toMatchObject({
      key: 'photo:same-upload', capsuleId: 'a-special',
      memoryId: 'capsule-a-special-same-upload', source: thumbnail, scanSource: image,
    })
    expect(weekly.capsuleId).toBe('z-weekly')
    expect(special.image).toBe('https://example.test/full.jpg')

    const directPhoto: JournalPhoto = { ...weekly, caption: 'A distinct Journal upload', syncStatus: 'synced' }
    const mixed = toPeopleTimelinePhotos([weekly, special], [directPhoto])
    expect(mixed.map(({ key }) => key)).toEqual(['photo:same-upload', 'journal-photo:same-upload'])
  })

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
      displayWidth: 1920,
      displayHeight: 1080,
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
      displayWidth: 1200,
      displayHeight: 900,
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
      detectedFace('face-1', shiftedDescriptor(maya, 0.15)),
      detectedFace('face-2', shiftedDescriptor(leena, 0.15)),
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
    enroll(ambiguousIdentity, 'leena', shiftedDescriptor(maya, 0.3))
    addScan(
      ambiguousIdentity,
      'candidate',
      detectedFace('face-1', shiftedDescriptor(maya, 0.15)),
    )

    const duplicateIdentity = emptyPeopleTimelineState()
    duplicateIdentity.people = [person('maya')]
    enroll(duplicateIdentity, 'maya', maya)
    addScan(
      duplicateIdentity,
      'candidate',
      detectedFace('face-1', shiftedDescriptor(maya, 0.15)),
      detectedFace('face-2', shiftedDescriptor(maya, 0.155)),
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
      detectedFace('face-1', shiftedDescriptor(alternate, 0.15)),
    )

    expect(createFaceSuggestions(state)).toContainEqual(expect.objectContaining({
      photoKey: 'candidate',
      faceId: 'face-1',
      personId: 'maya',
    }))
  })

  it('uses an explicitly confirmed cross-age face to recognize a near-exact new appearance', () => {
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
      detectedFace('face-1', shiftedDescriptor(child, 0.15)),
    )

    expect(createFaceSuggestions(state)).toContainEqual(expect.objectContaining({
      photoKey: 'candidate',
      faceId: 'face-1',
      personId: 'maya',
    }))
    expect(createFaceReviewCandidates(state)).not.toContainEqual(expect.objectContaining({ photoKey: 'candidate' }))
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

  it('automatically groups clear faces, reviews only plausible matches, and ignores weak ones', () => {
    const maya = faceResDescriptor()
    const state = emptyPeopleTimelineState()
    state.people = [person('maya')]
    enroll(state, 'maya', maya)
    addScan(state, 'clear-match', detectedFace('face-1', shiftedDescriptor(maya, 0.15)))
    addScan(state, 'possible-match', detectedFace('face-1', shiftedDescriptor(maya, 0.18)))
    addScan(state, 'weak-match', detectedFace('face-1', shiftedDescriptor(maya, 0.3)))
    addScan(state, 'poor-quality', detectedFace('face-1', maya, 0.36))
    const before = structuredClone(state)

    const automatic = createFaceSuggestions(state)
    expect(automatic.map(({ photoKey }) => photoKey)).toEqual(['clear-match'])
    expect(effectivePeopleForPhoto(state, 'clear-match', automatic)).toEqual(['maya'])
    expect(createFaceReviewCandidates(state).map(({ photoKey }) => photoKey))
      .toEqual(['possible-match'])
    expect(effectivePeopleForPhoto(state, 'weak-match', automatic)).toEqual([])
    // Ignoring a weak match is a read-only filter, not a permanent dismissal or
    // removal of the original, stored scan, or an existing manual decision.
    expect(state).toEqual(before)
  })

  it.each([
    { score: 0.55, quality: 0.9, expected: 'ignored' },
    { score: 0.62, quality: 0.9, expected: 'ignored' },
    { score: 0.77, quality: 0.9, expected: 'ignored' },
    { score: 0.78, quality: 0.9, expected: 'review' },
    { score: 0.91, quality: 0.9, expected: 'review' },
    { score: 0.92, quality: 0.9, expected: 'automatic' },
    { score: 0.79, quality: 0.55, expected: 'ignored' },
    { score: 0.8, quality: 0.55, expected: 'review' },
    { score: 1, quality: 0.74, expected: 'review' },
    { score: 1, quality: 0.75, expected: 'automatic' },
    { score: 1, quality: 0.549, expected: 'ignored' },
    { score: 1, quality: Number.NaN, expected: 'ignored' },
  ])('classifies similarity $score at quality $quality as $expected', ({ score, quality, expected }) => {
    const maya = faceResDescriptor()
    // For 1024 components, Human's amplified distance root is 160 * delta.
    const candidate = shiftedDescriptor(maya, (0.8 - 0.6 * score) / 1.6)
    expect(faceResSimilarity(maya, candidate)).toBe(score)
    const state = emptyPeopleTimelineState()
    state.people = [person('maya')]
    enroll(state, 'maya', maya)
    addScan(state, 'candidate', { ...detectedFace('face-1', candidate, quality), minFacePixels: 128 })
    expect(createFaceSuggestions(state)).toHaveLength(expected === 'automatic' ? 1 : 0)
    expect(createFaceReviewCandidates(state)).toHaveLength(expected === 'review' ? 1 : 0)
  })

  it('keeps likely but not uniquely identified relatives out of automatic albums', () => {
    const maya = faceResDescriptor()
    const state = emptyPeopleTimelineState()
    state.people = [person('maya'), person('leena')]
    enroll(state, 'maya', maya)
    enroll(state, 'leena', shiftedDescriptor(maya, 0.42))
    addScan(state, 'likely-maya', detectedFace('face-1', shiftedDescriptor(maya, 0.2)))
    addScan(state, 'identity-tie', detectedFace('face-1', shiftedDescriptor(maya, 0.21)))
    expect(createFaceSuggestions(state)).toEqual([])
    expect(createFaceReviewCandidates(state)).toEqual([
      expect.objectContaining({ photoKey: 'likely-maya', personId: 'maya' }),
    ])
  })

  it('keeps the review identity margin inclusive without accepting an identity tie', () => {
    const maya = faceResDescriptor()
    const candidate = shiftedDescriptor(maya, 0.19625) // .81 match
    const leena = shiftedDescriptor(candidate, 0.2075) // .78 competing identity
    const state = emptyPeopleTimelineState()
    state.people = [person('maya'), person('leena')]
    enroll(state, 'maya', maya)
    enroll(state, 'leena', leena)
    expect(faceResSimilarity(candidate, maya)).toBe(0.81)
    expect(faceResSimilarity(candidate, leena)).toBe(0.78)
    addScan(state, 'candidate', detectedFace('face-1', candidate))
    expect(createFaceSuggestions(state)).toEqual([])
    expect(createFaceReviewCandidates(state)).toEqual([
      expect.objectContaining({ photoKey: 'candidate', personId: 'maya' }),
    ])
  })

  it('honors explicit review decisions while leaving sibling faces reviewable', () => {
    const maya = faceResDescriptor()
    const leena = shiftedDescriptor(maya, 0.8)
    const state = emptyPeopleTimelineState()
    state.people = [person('maya'), person('leena')]
    enroll(state, 'maya', maya)
    enroll(state, 'leena', leena)
    for (const photoKey of ['dismissed', 'confirmed', 'legacy-dismissed']) {
      addScan(state, photoKey,
        detectedFace('face-1', shiftedDescriptor(maya, 0.18)),
        detectedFace('face-2', shiftedDescriptor(leena, 0.18)))
    }
    state.dismissedSuggestions = [
      { photoKey: 'dismissed', faceId: 'face-1', personId: 'maya', dismissedAt: '2026-01-01' },
      { photoKey: 'legacy-dismissed', personId: 'maya', dismissedAt: '2026-01-01' },
    ]
    // A whole-photo tag should stay accepted, without teaching a new face.
    state.assignments = [{ photoKey: 'confirmed', personId: 'maya', source: 'manual', confirmedAt: '2026-01-01' }]
    const reviews = createFaceReviewCandidates(state)
    expect(reviews).toHaveLength(3)
    expect(reviews.every(({ faceId, personId }) => faceId === 'face-2' && personId === 'leena')).toBe(true)
    expect(effectivePeopleForPhoto(state, 'confirmed')).toEqual(['maya'])
  })

  it('reconsiders ignored saved scans after enrollment improves without scanning or deleting them', () => {
    const maya = faceResDescriptor()
    const oldAppearance = shiftedDescriptor(maya, 0.3)
    const state = emptyPeopleTimelineState()
    state.people = [person('maya')]
    enroll(state, 'maya', maya)
    addScan(state, 'old-photo', detectedFace('face-1', oldAppearance))
    expect(createFaceSuggestions(state)).toEqual([])
    expect(createFaceReviewCandidates(state)).toEqual([])
    const scans = state.faceScans
    enroll(state, 'maya', maya, oldAppearance)
    expect(createFaceSuggestions(state)).toEqual([
      expect.objectContaining({ photoKey: 'old-photo', personId: 'maya' }),
    ])
    expect(createFaceReviewCandidates(state)).toEqual([])
    expect(state.faceScans).toBe(scans)
    expect(state.dismissedSuggestions).toEqual([])
  })

  it('does not turn thousands of weak gallery matches into review work', () => {
    const maya = faceResDescriptor()
    const weak = shiftedDescriptor(maya, 0.3)
    const state = emptyPeopleTimelineState()
    state.people = [person('maya')]
    enroll(state, 'maya', maya)
    for (let index = 0; index < 4_000; index += 1) {
      addScan(state, `gallery-${index}`, detectedFace('face-1', weak))
    }
    addScan(state, 'clear', detectedFace('face-1', maya))
    addScan(state, 'possible', detectedFace('face-1', shiftedDescriptor(maya, 0.18)))
    expect(createFaceSuggestions(state).map(({ photoKey }) => photoKey)).toEqual(['clear'])
    expect(createFaceReviewCandidates(state).map(({ photoKey }) => photoKey)).toEqual(['possible'])
    expect(Object.keys(state.faceScans)).toHaveLength(4_002)
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
      detectedFace('face-1', shiftedDescriptor(maya, 0.15)),
      detectedFace('face-2', shiftedDescriptor(leena, 0.15)),
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

  it('does not migrate a legacy Capsule key onto a Journal photo with the same id', () => {
    const state = emptyPeopleTimelineState()
    state.people = [person('maya')]
    state.assignments = [{
      photoKey: 'capsule:removed-capsule:portrait',
      personId: 'maya',
      source: 'manual',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    }]
    const journalPhoto = {
      ...timelinePhoto('journal-photo:portrait', '2025-04-02T12:00:00.000Z'),
      id: 'portrait',
      kind: 'journal-photo' as const,
    }

    const migrated = migrateLegacyPeopleTimelineState(state, [journalPhoto])

    expect(migrated.assignments[0]?.photoKey).toBe(
      'capsule:removed-capsule:portrait',
    )
  })
})
