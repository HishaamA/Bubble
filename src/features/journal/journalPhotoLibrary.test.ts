import { describe, expect, it } from 'vitest'
import {
  journalPhotoAsUnlocked,
  mergeLocalJournalPhotos,
  mergeJournalPhotos,
} from './journalPhotoLibrary'
import type { JournalPhoto } from './journalPhotoTypes'

function photo(
  id: string,
  syncStatus: JournalPhoto['syncStatus'],
  source: Blob | string,
): JournalPhoto {
  return {
    id,
    image: source,
    thumbnail: source,
    width: 1200,
    height: 900,
    thumbnailWidth: 400,
    thumbnailHeight: 300,
    caption: id,
    capturedAt: '2020-01-01T00:00:00.000Z',
    contributorName: 'Maya',
    ownedByCurrentUser: true,
    syncStatus,
  }
}

describe('journal photo library helpers', () => {
  it('keeps durable local Blobs when the family server confirms an upload', () => {
    const localImage = new Blob(['local'], { type: 'image/jpeg' })
    const local = photo(
      '11111111-1111-4111-8111-111111111111',
      'pending',
      localImage,
    )
    const remote = {
      ...photo(local.id, 'synced', 'https://family.example/signed.jpg'),
      contributorName: 'Maya Ahmed',
    }

    const merged = mergeJournalPhotos([local], [remote])

    expect(merged).toEqual([
      expect.objectContaining({
        id: local.id,
        image: localImage,
        thumbnail: localImage,
        contributorName: 'Maya Ahmed',
        syncStatus: 'synced',
      }),
    ])
  })

  it('keeps offline pending uploads that are not on the family server yet', () => {
    const pending = photo('pending', 'pending', new Blob(['pending']))
    const family = photo('family', 'synced', 'https://family.example/photo.jpg')

    expect(mergeJournalPhotos([pending], [family]).map(({ id }) => id)).toEqual([
      'pending',
      'family',
    ])
  })

  it('does not replace a fresh signed URL with an expired cached URL', () => {
    const id = '22222222-2222-4222-8222-222222222222'
    const cached = {
      ...photo(id, 'synced', 'https://family.example/expired.jpg'),
      caption: 'Old caption',
    }
    const current = {
      ...photo(id, 'synced', 'https://family.example/fresh.jpg'),
      caption: 'Fresh caption',
    }

    expect(mergeLocalJournalPhotos([current], [cached])).toEqual([
      expect.objectContaining({
        image: 'https://family.example/fresh.jpg',
        thumbnail: 'https://family.example/fresh.jpg',
        caption: 'Fresh caption',
      }),
    ])
  })

  it('adapts direct photos for the existing full-screen family-photo viewer', () => {
    expect(journalPhotoAsUnlocked(
      photo('direct', 'pending', '/direct.jpg'),
    )).toMatchObject({
      id: 'direct',
      capsuleId: 'family-photo-library',
      capsuleTitle: 'Family photos',
    })
  })
})
