import { describe, expect, it } from 'vitest'
import {
  demoJournalPhotos,
  withDemoJournalPhotos,
} from './demoJournalPhotos'
import type { JournalPhoto } from './journalPhotoTypes'

const realPhoto: JournalPhoto = {
  id: 'real-family-photo',
  image: new Blob(['full'], { type: 'image/jpeg' }),
  thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }),
  width: 1200,
  height: 900,
  thumbnailWidth: 400,
  thumbnailHeight: 300,
  caption: 'A real family photo',
  capturedAt: '2026-08-20T12:00:00.000Z',
  contributorName: 'Maya',
  ownedByCurrentUser: true,
  syncStatus: 'pending',
}

describe('demo Journal photos', () => {
  it('uses stable local assets that stay eligible for the normal photo and face pipeline', () => {
    expect(demoJournalPhotos).toHaveLength(9)
    expect(demoJournalPhotos).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'demo-journal-park-picnic',
        image: '/assets/journal/demo/demo-park-picnic.jpg',
        thumbnail: '/assets/journal/demo/demo-park-picnic.jpg',
        width: 418,
        height: 418,
        syncStatus: 'synced',
      }),
    ]))
    expect(demoJournalPhotos.every(({ image, thumbnail }) =>
      typeof image === 'string' && image.startsWith('/assets/') &&
      typeof thumbnail === 'string' && thumbnail.startsWith('/assets/'),
    )).toBe(true)
  })

  it('returns the real collection unchanged outside demo mode', () => {
    const photos = [realPhoto]
    expect(withDemoJournalPhotos(photos, false)).toBe(photos)
  })

  it('adds demo entries in memory while preserving a real record on collision', () => {
    const collision = {
      ...realPhoto,
      id: demoJournalPhotos[0]?.id ?? 'demo-journal-dumpling-night',
    }
    const merged = withDemoJournalPhotos([realPhoto, collision], true)

    expect(merged).toHaveLength(demoJournalPhotos.length + 1)
    expect(merged.find(({ id }) => id === collision.id)).toBe(collision)
    expect(merged[0]).toBe(realPhoto)
  })
})
