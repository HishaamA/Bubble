import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMemberSessionCaches } from '../../../app/memberSessionCache'
import type { UnlockedCapsulePhoto } from '../capsuleJournalArchive'
import { makeGalleryPhotoSource, type PhoneGalleryAsset } from '../gallery/phoneGallery'
import type { JournalPhoto } from '../journalPhotoTypes'
import { phoneGalleryJournalPhotos } from '../phoneGalleryPhotos'
import { PeopleTimeline } from './PeopleTimeline'
import { createFaceSuggestions, toPeopleTimelinePhotos } from './peopleTimelineHelpers'
import {
  selectEffectivePeopleByPhoto, selectFamilyPhotoKeys, selectPeoplePhotoAlbums,
} from './peopleTimelineSelectors'
import { getPeopleTimelineSession } from './peopleTimelineSession'
import { emptyPeopleTimelineState, loadPeopleTimelineState, savePeopleTimelineState } from './peopleTimelineStore'
import type { PeopleTimelineState, StoredFaceDetection, StoredPhotoFaceScan } from './types'

// Exercise the real checkpoint/session/matching/UI path without running a model
// or reading the user's photo bytes. Native imports call this same mergeScans.
vi.mock('./galleryScanSession', () => ({ useGalleryScanSession: () => ({
  status: 'idle', total: 0, scanned: 0, pending: 0, failed: 0,
  pauseReason: null, requiresRestart: false, pause: vi.fn(), resume: vi.fn(), retry: vi.fn(),
}) }))
vi.mock('./faceRecognition', () => ({ scanReferencePortrait: vi.fn(), scanTimelineFaces: vi.fn() }))
vi.mock('./TimelinePhotoImage', () => ({
  TimelinePhotoImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}))
vi.mock('./peopleTimelineStore', async (original) => ({
  ...await original<typeof import('./peopleTimelineStore')>(),
  loadPeopleTimelineState: vi.fn(),
  savePeopleTimelineState: vi.fn(),
}))

const SCOPE = 'gallery-propagation:family'
const DATE = '2026-01-01T12:00:00.000Z'
const vector = (value: number) => Array<number>(1024).fill(value)
const face = (id: string, value: number): StoredFaceDetection => ({
  id, embedding: vector(value), box: [0.1, 0.1, 0.2, 0.3],
  detectorScore: 0.98, descriptorScore: 0.98, quality: 0.95, minFacePixels: 160,
})
const scan = (...faces: StoredFaceDetection[]): StoredPhotoFaceScan => ({ scannedAt: DATE, faces })
const manual = (photoKey: string, personId: string) => ({
  photoKey, personId, source: 'manual' as const, confirmedAt: DATE,
})

function uploadedPhoto(): JournalPhoto {
  return {
    id: 'old-upload', image: '/old-upload.jpg', thumbnail: '/old-upload.jpg',
    width: 1200, height: 900, capturedAt: '2020-01-01T12:00:00.000Z',
    caption: 'Our original upload', contributorName: 'Family', ownedByCurrentUser: true,
    syncStatus: 'synced',
  }
}

function capsulePhoto(): UnlockedCapsulePhoto {
  return {
    id: 'old-capsule', capsuleId: 'unlocked-week', capsuleTitle: 'Our week',
    capsuleOpensAt: '2021-01-01T12:00:00.000Z',
    image: '/old-capsule.jpg', thumbnail: '/old-capsule.jpg', width: 1200, height: 900,
    capturedAt: '2021-01-01T12:00:00.000Z', caption: 'Our original capsule',
    contributorName: 'Family', ownedByCurrentUser: false,
  }
}

function galleryPhotos(count: number) {
  const assets: PhoneGalleryAsset[] = Array.from({ length: count }, (_, index) => ({
    id: `device-gallery:${index + 1}`, nativeId: String(index + 1),
    source: makeGalleryPhotoSource(String(index + 1), SCOPE, DATE),
    capturedAt: DATE, modifiedAt: DATE, width: 1200, height: 900,
    filename: `photo-${index + 1}.jpg`,
  }))
  return phoneGalleryJournalPhotos(assets).map((photo, index) => ({
    ...photo, caption: `Gallery memory ${index + 1}`,
  }))
}

function initialState(): PeopleTimelineState {
  const state = emptyPeopleTimelineState()
  state.people = ['Maya', 'Leena', 'Gran', 'Dad'].map((name) => ({
    id: name.toLowerCase(), name, createdAt: DATE,
  }))
  state.faceProfiles = Object.fromEntries([['maya', 1], ['leena', 3]].map(([id, value]) => [id, {
    references: [{ id: `${id}-portrait`, embedding: vector(Number(value)),
      source: 'enrollment' as const, quality: 0.95, createdAt: DATE }],
  }]))
  state.faceScans = {
    'journal-photo:old-upload': scan(),
    'photo:old-capsule': scan(face('face-1', 1), face('face-2', 3)),
  }
  // Manual labels remain valid even for family members without face enrollment.
  state.assignments = [manual('journal-photo:old-upload', 'gran'), manual('journal-photo:old-upload', 'dad')]
  return state
}

beforeEach(() => {
  clearMemberSessionCaches()
  localStorage.clear()
  vi.mocked(loadPeopleTimelineState).mockReset().mockResolvedValue(initialState())
  vi.mocked(savePeopleTimelineState).mockReset().mockResolvedValue(true)
})
afterEach(() => clearMemberSessionCaches())

describe('gallery checkpoint match propagation', () => {
  it('updates an already-open named scrapbook when a native checkpoint is merged, without remounting', async () => {
    const gallery = galleryPhotos(1)
    const session = getPeopleTimelineSession(SCOPE)
    await session.hydrate()
    render(<MemoryRouter><PeopleTimeline
      photos={[capsulePhoto()]} journalPhotos={[uploadedPhoto(), ...gallery]}
      cacheNamespace={SCOPE} initialPersonId="maya" personAlbumOpen
    /></MemoryRouter>)

    expect(screen.getByText('1 little moment, gathered together.')).toBeInTheDocument()
    const heading = screen.getByRole('heading', { name: 'Maya' })
    const notes = screen.getByRole('textbox', { name: 'Notes' })
    fireEvent.change(notes, { target: { value: 'Keep this open while the scan finishes.' } })
    expect(screen.queryByText('Gallery memory 1')).not.toBeInTheDocument()

    await act(async () => {
      const result = await session.mergeScans({
        [`journal-photo:${gallery[0].id}`]: scan(face('face-1', 1)),
      })
      expect(result.saved).toBe(true)
    })

    expect(screen.getByRole('heading', { name: 'Maya' })).toBe(heading)
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBe(notes)
    expect(notes).toHaveValue('Keep this open while the scan finishes.')
    expect(screen.getByText('2 little moments, gathered together.')).toBeInTheDocument()
    expect(screen.getByText('Gallery memory 1')).toBeInTheDocument()
    expect(screen.getByText('Our original capsule')).toBeInTheDocument()
    expect(session.getSnapshot().state.assignments).toEqual(initialState().assignments)
    expect(savePeopleTimelineState).toHaveBeenLastCalledWith(SCOPE, session.getSnapshot().state)
  })

  it('updates the mounted Family slider and album counts when two of four people match a new gallery photo', async () => {
    const gallery = galleryPhotos(1)
    const session = getPeopleTimelineSession(SCOPE)
    await session.hydrate()
    render(<MemoryRouter><PeopleTimeline
      photos={[capsulePhoto()]} journalPhotos={[uploadedPhoto(), ...gallery]}
      cacheNamespace={SCOPE}
    /></MemoryRouter>)
    const slider = screen.getByRole('slider')
    expect(slider).toHaveAttribute('max', '1')
    expect(screen.getByRole('button', { name: "Open Maya's scrapbook, 1 matched photo" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'See all' }))
    expect(screen.getByRole('button', { name: "Open Gran's scrapbook, 1 matched photo" })).toBeInTheDocument()

    await act(async () => {
      await session.mergeScans({ [`journal-photo:${gallery[0].id}`]: scan(face('face-1', 1), face('face-2', 3)) })
    })

    expect(screen.getByRole('slider')).toBe(slider)
    expect(slider).toHaveAttribute('max', '2')
    expect(screen.getByRole('button', { name: "Open Maya's scrapbook, 2 matched photos" })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "Open Leena's scrapbook, 2 matched photos" })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "Open Gran's scrapbook, 1 matched photo" })).toBeInTheDocument()
    fireEvent.change(slider, { target: { value: '2' } })
    await waitFor(() => expect(screen.getByText('3 of 3')).toBeInTheDocument())
    expect(screen.getByRole('img', { name: 'Gallery memory 1' })).toBeInTheDocument()
    expect(session.getSnapshot().state.assignments).toEqual(initialState().assignments)
  })

  it('preserves upload/capsule Family photos, explicit tags and exclusions after all 4,699 gallery checkpoints are saved', async () => {
    const gallery = galleryPhotos(4699)
    const session = getPeopleTimelineSession(SCOPE)
    await session.hydrate()
    const keys = gallery.map(({ id }) => `journal-photo:${id}`)
    const original = session.getSnapshot().state
    session.replace({
      ...original,
      assignments: [...original.assignments, manual(keys[2], 'gran')],
      dismissedSuggestions: [{ photoKey: keys[3], personId: 'leena', dismissedAt: DATE }],
    })
    const assignments = [...session.getSnapshot().state.assignments]
    const scans = Object.fromEntries(keys.map((key) => [key, scan()]))
    scans[keys[0]] = scan(face('face-1', 1), face('face-2', 3))
    scans[keys[1]] = scan(face('face-1', 1))
    scans[keys[2]] = scan(face('face-1', 1))
    scans[keys[3]] = scan(face('face-1', 1), face('face-2', 3))
    const result = await session.mergeScans(scans)
    expect(result.saved).toBe(true)
    expect(result.mergedKeys).toHaveLength(4699)

    const complete = session.getSnapshot().state
    const photos = toPeopleTimelinePhotos([capsulePhoto()], [uploadedPhoto(), ...gallery])
    const automatic = createFaceSuggestions(complete)
    const effective = selectEffectivePeopleByPhoto(complete, photos, automatic)
    const family = selectFamilyPhotoKeys(photos, effective, new Set(complete.people.map(({ id }) => id)))
    expect(family).toEqual(new Set(['photo:old-capsule', 'journal-photo:old-upload', keys[0], keys[2]]))
    expect(family.has(keys[1])).toBe(false)
    expect(family.has(keys[3])).toBe(false)
    expect(effective.get(keys[3])).toEqual(new Set(['maya']))
    const { albums } = selectPeoplePhotoAlbums(complete.people, photos, effective)
    expect(albums.map(({ person, photoCount }) => [person.id, photoCount])).toEqual([
      ['maya', 5], ['leena', 2], ['gran', 2], ['dad', 1],
    ])
    expect(complete.assignments).toEqual(assignments)
    expect(complete.faceProfiles).toBe(original.faceProfiles)
    expect(complete.faceScans['photo:old-capsule']).toBe(original.faceScans['photo:old-capsule'])
    expect(Object.keys(complete.faceScans)).toHaveLength(4701)
    expect(photos).toHaveLength(4701)
    expect(savePeopleTimelineState).toHaveBeenLastCalledWith(SCOPE, complete)
  })
})
