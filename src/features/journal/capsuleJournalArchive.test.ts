import { describe, expect, it } from 'vitest'
import type { CapsulePhoto, FamilyCapsule } from '../capsules/types'
import {
  mergeJournalCapsules,
  unlockedCapsulePhotos,
} from './capsuleJournalArchive'

function photo(overrides: Partial<CapsulePhoto> = {}): CapsulePhoto {
  return {
    id: 'photo-one',
    capsuleId: 'capsule-local',
    image: '/family/full.jpg',
    thumbnail: '/family/thumb.jpg',
    width: 1200,
    height: 1600,
    caption: 'Friday flowers',
    capturedAt: '2026-08-28T18:00:00.000Z',
    contributorName: 'Simreen',
    ownedByCurrentUser: true,
    syncStatus: 'synced',
    ...overrides,
  }
}

function capsule(overrides: Partial<FamilyCapsule> = {}): FamilyCapsule {
  return {
    id: 'capsule-local',
    kind: 'weekly',
    title: 'This week',
    weekStart: '2026-08-24',
    createdAt: '2026-08-24T00:00:00.000Z',
    closesAt: '2026-08-30T23:59:59.000Z',
    opensAt: '2026-08-31T00:00:00.000Z',
    createdByName: 'Simreen',
    photos: [photo()],
    totalPhotoCount: 1,
    ...overrides,
  }
}

describe('Capsule Journal archive', () => {
  it('preserves durable local Blobs when family refreshes supply expiring URLs', () => {
    const localImage = new Blob(['full'], { type: 'image/jpeg' })
    const localThumbnail = new Blob(['thumb'], { type: 'image/webp' })
    const local = capsule({
      photos: [photo({
        image: localImage,
        thumbnail: localThumbnail,
      })],
    })
    const family = capsule({
      id: 'capsule-family',
      title: 'Family week',
      opensAt: '2026-09-01T00:00:00.000Z',
      familySynced: true,
      photos: [photo({
        capsuleId: 'capsule-family',
        image: 'https://signed.example/full?expires=soon',
        thumbnail: 'https://signed.example/thumb?expires=soon',
        contributorName: 'Maya',
      })],
    })

    const [merged] = mergeJournalCapsules([local], [family])

    expect(merged).toMatchObject({
      id: 'capsule-family',
      title: 'Family week',
      opensAt: '2026-09-01T00:00:00.000Z',
      familySynced: true,
    })
    expect(merged.photos[0]).toMatchObject({
      capsuleId: 'capsule-family',
      contributorName: 'Maya',
    })
    expect(merged.photos[0].image).toBe(localImage)
    expect(merged.photos[0].thumbnail).toBe(localThumbnail)
  })

  it('uses real server opensAt timing before exposing family photos', () => {
    const locallyExpired = capsule({
      opensAt: '2026-08-28T00:00:00.000Z',
    })
    const serverSealed = capsule({
      id: 'capsule-family',
      opensAt: '2026-08-31T00:00:00.000Z',
      familySynced: true,
      photos: [photo({ capsuleId: 'capsule-family' })],
    })
    const merged = mergeJournalCapsules([locallyExpired], [serverSealed])

    expect(
      unlockedCapsulePhotos(merged, new Date('2026-08-30T23:59:59.999Z')),
    ).toEqual([])
    expect(
      unlockedCapsulePhotos(merged, new Date('2026-08-31T00:00:00.000Z')),
    ).toEqual([
      expect.objectContaining({
        id: 'photo-one',
        capsuleId: 'capsule-family',
        capsuleTitle: 'This week',
        capsuleOpensAt: '2026-08-31T00:00:00.000Z',
      }),
    ])
  })

  it('never treats the session-only demo preview as a Journal unlock', () => {
    const demoPreviewedCapsule = {
      ...capsule({ opensAt: '2026-09-10T00:00:00.000Z' }),
      demoUnlocked: true,
    }

    expect(
      unlockedCapsulePhotos(
        [demoPreviewedCapsule],
        new Date('2026-08-29T12:00:00.000Z'),
      ),
    ).toEqual([])
  })

  it('keeps pending local photos while reconciling the family Capsule id', () => {
    const pending = photo({
      id: 'pending-photo',
      syncStatus: 'pending',
      image: new Blob(['pending full'], { type: 'image/jpeg' }),
      thumbnail: new Blob(['pending thumb'], { type: 'image/webp' }),
    })
    const local = capsule({ photos: [pending] })
    const family = capsule({
      id: 'capsule-family',
      familySynced: true,
      photos: [],
      totalPhotoCount: 0,
    })

    const [merged] = mergeJournalCapsules([local], [family])

    expect(merged.photos).toEqual([
      expect.objectContaining({
        id: 'pending-photo',
        capsuleId: 'capsule-family',
        syncStatus: 'pending',
      }),
    ])
    expect(merged.photos[0].image).toBe(pending.image)
  })
})
