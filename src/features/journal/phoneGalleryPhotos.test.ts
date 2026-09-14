import { describe, expect, it } from 'vitest'
import type { PhoneGalleryAsset } from './gallery/phoneGallery'
import { createMemoryJournalPhotoStore, parseStoredJournalPhoto } from './journalPhotoStore'
import { createFaceSuggestions, toPeopleTimelinePhotos } from './people/peopleTimelineHelpers'
import {
  selectEffectivePeopleByPhoto, selectEnrolledPersonIds, selectFamilyPhotoKeys,
  selectPeoplePhotoAlbums, selectVisibleTimelinePhotos,
} from './people/peopleTimelineSelectors'
import { emptyPeopleTimelineState } from './people/peopleTimelineStore'
import { FAMILY_PERSON_ID, type FaceReference, type PeopleTimelineState, type StoredFaceDetection } from './people/types'
import { GALLERY_TIMELINE_PREFIX, phoneGalleryJournalPhotos, prunePhoneGalleryMatches } from './phoneGalleryPhotos'

const now = '2026-09-13T09:30:00.000Z'
function asset(nativeId = 'one', modifiedAt: string | undefined = now): PhoneGalleryAsset {
  return {
    id: `device-gallery:${nativeId}`, nativeId,
    source: `bubble-gallery:${nativeId}?scope=member%3Afamily&v=${encodeURIComponent(modifiedAt ?? '')}`,
    capturedAt: '2026-09-12T08:00:00.000Z', modifiedAt,
    width: 4000, height: 3000, filename: 'Private original filename.jpg',
  }
}

describe('phone gallery Journal references', () => {
  it('maps metadata to device-only references without upload ownership or pending sync', () => {
    const input = asset()
    const result = phoneGalleryJournalPhotos([input])[0]
    expect(result).toMatchObject({ origin: 'device-gallery', ownedByCurrentUser: false, syncStatus: 'local',
      image: input.source, thumbnail: input.source, capturedAt: input.capturedAt, width: 4000, height: 3000 })
    expect(result.image).not.toBeInstanceOf(Blob)
    expect(result.thumbnail).not.toBeInstanceOf(Blob)
    expect(result).not.toHaveProperty('uploaderId')
    expect(result.caption).not.toContain(input.filename)
    expect(JSON.stringify(result)).not.toContain('base64')
  })

  it('deduplicates native asset identities and uses the last authoritative metadata row', () => {
    const first = asset()
    const updated = { ...first, width: 2000 }
    const result = phoneGalleryJournalPhotos([first, asset('two'), updated])
    expect(result).toHaveLength(2)
    expect(result[0].width).toBe(2000)
    expect(new Set(result.map(({ id }) => id)).size).toBe(2)
    expect(first.width).toBe(4000)
  })

  it('keeps IDs stable for an unchanged photo and invalidates face identity after modification', () => {
    const unchanged = phoneGalleryJournalPhotos([asset()])[0]
    const repeated = phoneGalleryJournalPhotos([asset()])[0]
    const edited = phoneGalleryJournalPhotos([asset('one', '2026-09-13T10:30:00.000Z')])[0]
    expect(repeated.id).toBe(unchanged.id)
    expect(edited.id).not.toBe(unchanged.id)
    expect(`journal-photo:${unchanged.id}`).toMatch(new RegExp(`^${GALLERY_TIMELINE_PREFIX}`))
    const undated = asset()
    delete undated.modifiedAt
    expect(phoneGalleryJournalPhotos([undated])[0].id).toBe('device-gallery:one:')
  })
})

function reference(id: string, photoKey?: string): FaceReference {
  return { id, source: photoKey ? 'manual-photo' : 'enrollment', photoKey,
    embedding: [0.1, 0.2], createdAt: now }
}

function stateFixture(): PeopleTimelineState {
  const gallery = `${GALLERY_TIMELINE_PREFIX}one:version`
  const keptGallery = `${GALLERY_TIMELINE_PREFIX}two:version`
  const uploaded = 'journal-photo:uploaded'
  const capsule = 'capsule-photo:opened'
  const keys = [gallery, keptGallery, uploaded, capsule]
  return {
    ...emptyPeopleTimelineState(),
    people: [{ id: 'mum', name: 'Mum', createdAt: now }],
    faceScans: Object.fromEntries(keys.map((key) => [key, { scannedAt: now, faces: [] }])),
    dateOverrides: Object.fromEntries(keys.map((key) => [key, { value: '2020', precision: 'year' as const }])),
    assignments: keys.map((photoKey) => ({ photoKey, personId: 'mum', source: 'manual' as const, confirmedAt: now })),
    dismissedSuggestions: keys.map((photoKey) => ({ photoKey, personId: 'mum', dismissedAt: now })),
    faceProfiles: { mum: { references: [reference('enrollment'), ...keys.map((key) => reference(key, key))] } },
  }
}

describe('linked gallery biometric cleanup', () => {
  it('forgets disconnected gallery scans, assignments, dates, suggestions and supplemental references only', () => {
    const state = stateFixture()
    const before = JSON.stringify(state)
    const next = prunePhoneGalleryMatches(state, new Set())
    expect(next.people).toBe(state.people)
    expect(Object.keys(next.faceScans)).toEqual(['journal-photo:uploaded', 'capsule-photo:opened'])
    expect(Object.keys(next.dateOverrides)).toEqual(['journal-photo:uploaded', 'capsule-photo:opened'])
    expect(next.assignments.map(({ photoKey }) => photoKey)).toEqual(['journal-photo:uploaded', 'capsule-photo:opened'])
    expect(next.dismissedSuggestions.map(({ photoKey }) => photoKey)).toEqual(['journal-photo:uploaded', 'capsule-photo:opened'])
    expect(next.faceProfiles.mum.references.map(({ id }) => id)).toEqual(['enrollment', 'journal-photo:uploaded', 'capsule-photo:opened'])
    expect(next.faceProfiles.mum.references[0]).toBe(state.faceProfiles.mum.references[0])
    expect(JSON.stringify(state)).toBe(before)
  })

  it('preserves allowed linked photos while removing inaccessible or old-version matches', () => {
    const state = stateFixture()
    const allowed = `${GALLERY_TIMELINE_PREFIX}two:version`
    const next = prunePhoneGalleryMatches(state, new Set([allowed]))
    expect(next.faceScans[allowed]).toBe(state.faceScans[allowed])
    expect(next.assignments.some(({ photoKey }) => photoKey === allowed)).toBe(true)
    expect(next.faceProfiles.mum.references.some(({ photoKey }) => photoKey === allowed)).toBe(true)
    expect(next.faceScans[`${GALLERY_TIMELINE_PREFIX}one:version`]).toBeUndefined()
  })

  it('returns the exact original object if no cleanup is necessary', () => {
    const state = stateFixture()
    const all = new Set(Object.keys(state.faceScans))
    expect(prunePhoneGalleryMatches(state, all)).toBe(state)
    const empty = emptyPeopleTimelineState()
    expect(prunePhoneGalleryMatches(empty, new Set())).toBe(empty)
  })

  it('detects a supplemental gallery reference even when no other scan metadata remains', () => {
    const state = emptyPeopleTimelineState()
    const kept = reference('enrolled')
    state.faceProfiles.mum = { references: [kept, reference('linked', `${GALLERY_TIMELINE_PREFIX}gone`)] }
    const next = prunePhoneGalleryMatches(state, new Set())
    expect(next.faceProfiles.mum.references).toEqual([kept])
  })
})

describe('linked gallery uses the existing people and family timeline pipeline', () => {
  it('groups native references through ordinary face matches and manual decisions, with corrected slider dates', () => {
    const linked = phoneGalleryJournalPhotos([
      asset('group'), asset('solo'), { ...asset('manual'), capturedAt: '2010-01-01T12:00:00.000Z' },
    ])
    const photos = toPeopleTimelinePhotos([], linked)
    expect(photos).toHaveLength(3)
    for (let index = 0; index < photos.length; index += 1) {
      expect(photos[index]).toMatchObject({ origin: 'device-gallery', kind: 'journal-photo',
        canScanFaces: true, source: linked[index].thumbnail, scanSource: linked[index].image })
    }
    const [group, solo, manual] = photos
    const state = emptyPeopleTimelineState()
    state.people = ['mum', 'dad', 'child', 'gran'].map((id) => ({ id, name: id, createdAt: now }))
    const mum = Array.from({ length: 1024 }, (_, index) => (index % 7) / 10)
    const dad = mum.map((value) => value + 1)
    state.faceProfiles = {
      mum: { references: [{ ...reference('mum-enrollment'), embedding: mum, quality: 0.9 }] },
      dad: { references: [{ ...reference('dad-enrollment'), embedding: dad, quality: 0.9 }] },
    }
    const face = (id: string, embedding: number[]): StoredFaceDetection => ({
      id, embedding, box: [0.1, 0.1, 0.3, 0.4], detectorScore: 0.95, descriptorScore: 0.95, quality: 0.9,
    })
    state.faceScans = {
      [group.key]: { scannedAt: now, faces: [face('mum-face', mum), face('dad-face', dad)] },
      [solo.key]: { scannedAt: now, faces: [face('mum-face', mum)] },
    }
    state.assignments = ['mum', 'dad'].map((personId) => ({
      photoKey: manual.key, personId, source: 'manual', confirmedAt: now,
    }))
    state.dateOverrides[group.key] = { value: '2001', precision: 'year' }
    const matches = createFaceSuggestions(state)
    expect(matches).toHaveLength(3)
    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ photoKey: group.key, personId: 'mum', faceId: 'mum-face' }),
      expect.objectContaining({ photoKey: group.key, personId: 'dad', faceId: 'dad-face' }),
      expect.objectContaining({ photoKey: solo.key, personId: 'mum' }),
    ]))
    const effectivePeople = selectEffectivePeopleByPhoto(state, photos, matches)
    const familyPhotoKeys = selectFamilyPhotoKeys(photos, effectivePeople, new Set(state.people.map(({ id }) => id)))
    expect(familyPhotoKeys).toEqual(new Set([group.key, manual.key]))
    const select = (selectedPersonId: string) => selectVisibleTimelinePhotos({
      selectedPersonId, photos, reviewMatches: [], effectivePeople, familyPhotoKeys, dateOverrides: state.dateOverrides,
    }).map(({ key }) => key)
    expect(select(FAMILY_PERSON_ID)).toEqual([group.key, manual.key])
    expect(select('mum')).toEqual([group.key, manual.key, solo.key])
    expect(select('dad')).toEqual([group.key, manual.key])
    expect(selectPeoplePhotoAlbums(state.people, photos, effectivePeople).albums.map(({ person, photoCount }) => [person.id, photoCount]))
      .toEqual([['mum', 3], ['dad', 2]])
  })

  it('honors a dismissed gallery face without removing a manually confirmed relative', () => {
    const photos = toPeopleTimelinePhotos([], phoneGalleryJournalPhotos([asset('group')]))
    const key = photos[0].key
    const state = emptyPeopleTimelineState()
    state.people = ['mum', 'dad'].map((id) => ({ id, name: id, createdAt: now }))
    state.faceProfiles = { mum: { references: [reference('mum')] }, dad: { references: [reference('dad')] } }
    state.assignments = [{ photoKey: key, personId: 'dad', source: 'manual', confirmedAt: now }]
    state.dismissedSuggestions = [{ photoKey: key, personId: 'mum', faceId: 'mum-face', dismissedAt: now }]
    const effective = selectEffectivePeopleByPhoto(state, photos, [
      { photoKey: key, personId: 'mum', faceId: 'mum-face', confidence: 0.95 },
    ])
    expect(effective.get(key)).toEqual(new Set(['dad']))
    expect(selectFamilyPhotoKeys(photos, effective, selectEnrolledPersonIds(state.faceProfiles))).toEqual(new Set())
    expect(selectPeoplePhotoAlbums(state.people, photos, effective).albums.map(({ person }) => person.id)).toEqual(['dad'])
  })

  it('never accepts linked references into the durable Journal copy/upload store', async () => {
    const linked = phoneGalleryJournalPhotos([asset()])[0]
    const uploaded = { ...linked, id: 'uploaded', origin: undefined,
      image: '/uploaded.jpg', thumbnail: '/uploaded-thumbnail.jpg', syncStatus: 'synced' as const }
    expect(parseStoredJournalPhoto(linked)).toBeNull()
    expect(parseStoredJournalPhoto({ ...linked, syncStatus: 'synced' })).toBeNull()
    expect(parseStoredJournalPhoto({ ...linked, origin: undefined })).toBeNull()
    const store = createMemoryJournalPhotoStore([linked, uploaded])
    expect((await store.list()).map(({ id }) => id)).toEqual(['uploaded'])
    await expect(store.save(linked)).rejects.toThrow('invalid')
    expect((await store.list()).map(({ id }) => id)).toEqual(['uploaded'])
  })
})
