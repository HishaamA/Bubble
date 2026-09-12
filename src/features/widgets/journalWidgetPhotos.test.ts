import { describe, expect, it } from 'vitest'
import type { FamilyCapsule } from '../capsules/types'
import { JOURNAL_LIBRARY_ID, type JournalPhoto } from '../journal/journalPhotoTypes'
import { journalWidgetPhotoRoute, selectJournalWidgetPhotos } from './journalWidgetPhotos'
import { selectBubbleWidgetTimeline } from './widgetSnapshot'

const now = new Date(2026, 8, 11, 14, 15)

function photo(id: string, overrides: Partial<JournalPhoto> = {}): JournalPhoto {
  return {
    id, caption: `Memory ${id}`, capturedAt: '2020-01-01T12:00:00.000Z',
    image: `https://example.test/${id}.jpg`, thumbnail: `https://example.test/${id}-thumb.jpg`,
    width: 800, height: 600, contributorName: 'Family', ownedByCurrentUser: false,
    syncStatus: 'synced', ...overrides,
  }
}

function capsule(id: string, overrides: Partial<FamilyCapsule> = {}): FamilyCapsule {
  return {
    id, title: 'A celebration', kind: 'special', createdByName: 'Family',
    createdAt: '2020-01-01T00:00:00.000Z', closesAt: '2020-01-02T00:00:00.000Z',
    opensAt: '2020-01-02T00:00:00.000Z', familySynced: true,
    photos: [{ ...photo('shared-id'), capsuleId: id }], ...overrides,
  }
}

describe('Journal widget memories', () => {
  it('shows one upload once when it belongs to two revealed Capsules, without hiding a direct upload with the same ID', () => {
    const weekly = capsule('z-weekly', { kind: 'weekly' })
    const special = capsule('a-special')
    const result = selectJournalWidgetPhotos([photo('shared-id')], [weekly, special], now)
    expect(result).toHaveLength(2)
    expect(result).toEqual(selectJournalWidgetPhotos([photo('shared-id')], [special, weekly], now))
    expect(new Set(result.map(journalWidgetPhotoRoute))).toEqual(new Set([
      '/journal?photo=shared-id&collection=family-photo-library&source=widget',
      '/journal?photo=shared-id&collection=a-special&source=widget',
    ]))
  })

  it('filters locked and pending duplicates before selecting a canonical authorized collection', () => {
    const result = selectJournalWidgetPhotos([], [
      capsule('a-locked', { opensAt: '2027-01-01T00:00:00.000Z' }),
      capsule('b-pending', { photos: [{ ...photo('shared-id', { syncStatus: 'pending' }), capsuleId: 'b-pending' }] }),
      capsule('z-opened'),
    ], now)
    expect(result).toHaveLength(1)
    expect(result[0].collectionId).toBe('z-opened')
  })

  it('keeps a native photo page ID stable if the same upload gains another Capsule membership', () => {
    const input = { now, theme: 'plum' as const, privacy: 'full' as const, events: [] }
    const before = selectBubbleWidgetTimeline({ ...input, authorizedCapsules: [capsule('z-weekly')] })
    const after = selectBubbleWidgetTimeline({ ...input, authorizedCapsules: [capsule('z-weekly'), capsule('a-special')] })
    expect(before.snapshot.pages).toHaveLength(1)
    expect(after.snapshot.pages).toHaveLength(1)
    expect(after.snapshot.pages![0].id).toBe(before.snapshot.pages![0].id)
    expect(after.snapshot.pages![0].route).toContain('collection=a-special')
  })

  it('combines all uploaded library photos and revealed Capsule photos with collection-aware IDs', () => {
    const result = selectJournalWidgetPhotos([photo('shared-id')], [capsule('celebration')], now)
    expect(result).toHaveLength(2)
    expect(new Set(result.map(journalWidgetPhotoRoute))).toEqual(new Set([
      '/journal?photo=shared-id&collection=family-photo-library&source=widget',
      '/journal?photo=shared-id&collection=celebration&source=widget',
    ]))
    expect(result.some((entry) => entry.collectionId === JOURNAL_LIBRARY_ID)).toBe(true)
  })

  it('never uses locked, local-only, pending, invalid, or duplicate rows', () => {
    const invalid = photo('invalid', { capturedAt: 'not-a-date' })
    const pending = photo('pending', { syncStatus: 'pending' })
    const result = selectJournalWidgetPhotos(
      [photo('shared'), photo('shared'), pending, invalid, photo('')],
      [
        capsule('locked', { opensAt: '2027-01-01T00:00:00.000Z' }),
        capsule('local', { familySynced: false }),
        capsule('invalid', { closesAt: 'not-a-date' }),
      ], now,
    )
    expect(result.map(({ photo }) => photo.id)).toEqual(['shared'])
    expect(selectJournalWidgetPhotos([photo('one')], [], new Date('invalid'))).toEqual([])
  })

  it('stays stable within an hour, rotates hourly without immediate repeats, and eventually shows every upload', () => {
    const photos = Array.from({ length: 20 }, (_, index) => photo(`${index}`))
    const original = [...photos]
    const first = selectJournalWidgetPhotos(photos, [], now)
    expect(selectJournalWidgetPhotos([...photos].reverse(), [], new Date(2026, 8, 11, 14, 59)))
      .toEqual(first)
    const visited = Array.from({ length: photos.length }, (_, hour) => {
      const at = new Date(now.getTime() + hour * 60 * 60 * 1_000)
      return selectJournalWidgetPhotos(photos, [], at)[0].photo.id
    })
    expect(new Set(visited).size).toBe(photos.length)
    expect(photos).toEqual(original)
    expect(first.map(({ photo }) => photo.id)).not.toEqual(photos.map(({ id }) => id))
  })

  it('encodes raw identifiers without putting photos on a separate viewer route', () => {
    expect(journalWidgetPhotoRoute({ collectionId: 'summer / friends', photo: photo('one&two') }))
      .toBe('/journal?photo=one%26two&collection=summer%20%2F%20friends&source=widget')
  })

  it('matches the automatic memory to its first photo page, bounds native media, and asks for an hourly refresh', () => {
    const selection = selectBubbleWidgetTimeline({
      now, theme: 'plum', privacy: 'full', events: [], authorizedCapsules: [],
      authorizedJournalPhotos: Array.from({ length: 30 }, (_, index) => photo(`${index}`)),
    })
    expect(selection.snapshot.kind).toBe('memory')
    expect(selection.snapshot.pages).toHaveLength(6)
    const firstPage = selection.snapshot.pages![0]
    expect(selection.snapshot.route).toBe(firstPage.route)
    expect(selection.thumbnail).toBe(selection.pageThumbnails![firstPage.id])
    expect(Object.keys(selection.pageThumbnails!)).toHaveLength(6)
    expect(selection.snapshot.nextRefreshAt).toBe(new Date(2026, 8, 11, 15).toISOString())
  })

  it('does not leak Journal captions, media, or pages when widget previews are private', () => {
    const selection = selectBubbleWidgetTimeline({
      now, theme: 'forest', privacy: 'hidden', events: [], authorizedCapsules: [],
      authorizedJournalPhotos: [photo('one', { caption: 'PRIVATE_MEMORY' })],
    })
    expect(selection.snapshot.kind).toBe('memory')
    expect(selection.thumbnail).toBeUndefined()
    expect(selection.pageThumbnails).toBeUndefined()
    expect(selection.snapshot.pages).toBeUndefined()
    expect(JSON.stringify(selection)).not.toMatch(/PRIVATE_MEMORY|https:\/\//)
  })
})
