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
  it('does not seed generated photos into an empty account', () => {
    expect(demoJournalPhotos).toEqual([])
  })

  it('returns the real collection unchanged outside demo mode', () => {
    const photos = [realPhoto]
    expect(withDemoJournalPhotos(photos, false)).toBe(photos)
  })

  it('keeps the real collection unchanged in demo mode', () => {
    const photos = [realPhoto]
    expect(withDemoJournalPhotos(photos, true)).toBe(photos)
  })
})
