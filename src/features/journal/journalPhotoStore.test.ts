import { describe, expect, it } from 'vitest'
import {
  createMemoryJournalPhotoStore,
  journalPhotoDatabaseNameForSubject,
  parseStoredJournalPhoto,
} from './journalPhotoStore'
import type { JournalPhoto } from './journalPhotoTypes'

function photo(id: string, capturedAt: string): JournalPhoto {
  return {
    id,
    image: new Blob([`full-${id}`], { type: 'image/jpeg' }),
    thumbnail: new Blob([`thumb-${id}`], { type: 'image/jpeg' }),
    width: 1200,
    height: 900,
    thumbnailWidth: 400,
    thumbnailHeight: 300,
    caption: id,
    capturedAt,
    contributorName: 'Maya',
    ownedByCurrentUser: true,
    syncStatus: 'pending',
  }
}

describe('journalPhotoStore', () => {
  it('saves processed Blobs independently and returns newest first', async () => {
    const store = createMemoryJournalPhotoStore()
    const older = photo('older', '2010-01-01T00:00:00.000Z')
    const newer = photo('newer', '2020-01-01T00:00:00.000Z')

    await store.save(older)
    await store.save(newer)
    older.caption = 'mutated outside store'

    const saved = await store.list()
    expect(saved.map(({ id }) => id)).toEqual(['newer', 'older'])
    expect(saved[1]?.caption).toBe('older')
    expect(saved[0]?.image).toBeInstanceOf(Blob)

    await store.remove('newer')
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ id: 'older' }),
    ])
  })

  it('isolates IndexedDB names by account and family namespace', () => {
    expect(journalPhotoDatabaseNameForSubject('user-a:family-one')).not.toBe(
      journalPhotoDatabaseNameForSubject('user-a:family-two'),
    )
    expect(journalPhotoDatabaseNameForSubject('')).toContain('signed-out')
  })

  it('preserves authenticated uploader identity across durable writes without requiring it on legacy imports', async () => {
    const store = createMemoryJournalPhotoStore()
    const legacy = photo('legacy', '2020-01-01T00:00:00.000Z')
    const hydrated = { ...legacy, id: 'hydrated', uploaderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
    await store.save(legacy)
    await store.save(hydrated)
    expect(await store.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'hydrated', uploaderId: hydrated.uploaderId }),
      expect.objectContaining({ id: 'legacy', ownedByCurrentUser: true }),
    ]))
    expect(parseStoredJournalPhoto({ ...legacy, uploaderId: 'invalid' })).toEqual(legacy)
  })

  it('rejects malformed records instead of feeding them into the face queue', async () => {
    const store = createMemoryJournalPhotoStore()
    await expect(store.save({
      ...photo('broken', '2020-01-01T00:00:00.000Z'),
      capturedAt: 'not-a-date',
    })).rejects.toThrow('invalid')
    await expect(store.list()).resolves.toEqual([])
  })
})
