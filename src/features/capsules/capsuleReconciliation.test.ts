import { describe, expect, it } from 'vitest'
import { getWeeklyCapsuleWindow, toLocalDateInput } from './capsuleDates'
import {
  createCurrentWeeklyCapsule,
  mergeCapsules,
  orderCapsules,
} from './capsuleReconciliation'
import type { CapsulePhoto, FamilyCapsule } from './types'

const now = new Date(2026, 7, 29, 12)

function photo(overrides: Partial<CapsulePhoto> = {}): CapsulePhoto {
  return {
    id: 'photo-one',
    capsuleId: 'remote-week',
    image: '/fresh-image.jpg',
    thumbnail: '/fresh-thumbnail.jpg',
    width: 900,
    height: 1200,
    caption: 'A family afternoon',
    capturedAt: '2026-08-28T12:00:00.000Z',
    contributorName: 'Simreen',
    ownedByCurrentUser: true,
    syncStatus: 'synced',
    ...overrides,
  }
}

function capsule(overrides: Partial<FamilyCapsule> = {}): FamilyCapsule {
  return {
    ...createCurrentWeeklyCapsule(now),
    id: 'remote-week',
    familySynced: true,
    photos: [],
    ...overrides,
  }
}

describe('capsule reconciliation', () => {
  it('gives offline drafts a deterministic local-week identity and collection window', () => {
    const window = getWeeklyCapsuleWindow(now)
    const week = createCurrentWeeklyCapsule(now, 'Simreen')
    expect(week).toMatchObject({
      id: `weekly-${toLocalDateInput(window.weekStart)}`,
      weekStart: toLocalDateInput(window.weekStart),
      createdAt: window.weekStart.toISOString(),
      closesAt: window.closesAt.toISOString(),
      opensAt: window.opensAt.toISOString(),
      createdByName: 'Simreen',
      familySynced: false,
      totalPhotoCount: 0,
      photos: [],
    })
    expect(createCurrentWeeklyCapsule(new Date(2026, 7, 25, 9)).id).toBe(week.id)
  })

  it('orders weekly capsules first and each kind newest-first without mutating input', () => {
    const older = capsule({ id: 'older', createdAt: '2026-08-17' })
    const newest = capsule({ id: 'newest', createdAt: '2026-08-24' })
    const special = capsule({ id: 'special', kind: 'special', createdAt: '2026-09-01' })
    const olderSpecial = capsule({ id: 'older-special', kind: 'special', createdAt: '2026-08-01' })
    const input = [olderSpecial, special, older, newest]
    expect(orderCapsules(input).map(({ id }) => id)).toEqual(['newest', 'older', 'special', 'older-special'])
    expect(input.map(({ id }) => id)).toEqual(['older-special', 'special', 'older', 'newest'])
  })

  it('lets the server own metadata while retaining local durable image bytes', () => {
    const image = new Blob(['full-resolution'])
    const thumbnail = new Blob(['thumbnail'])
    const local = capsule({
      title: 'Old title',
      photos: [photo({ image, thumbnail, caption: 'Old caption', syncStatus: 'pending' })],
    })
    const remote = capsule({ title: 'Family title', photos: [photo()], totalPhotoCount: 4 })
    const [merged] = mergeCapsules([local], [remote])
    expect(merged).toMatchObject({ title: 'Family title', totalPhotoCount: 4 })
    expect(merged.photos[0]).toMatchObject({ caption: 'A family afternoon', syncStatus: 'synced' })
    expect(merged.photos[0].image).toBe(image)
    expect(merged.photos[0].thumbnail).toBe(thumbnail)
    expect(remote.photos[0].image).toBe('/fresh-image.jpg')
    expect(local.photos[0].syncStatus).toBe('pending')
  })

  it('renews string URLs independently of any locally retained thumbnail Blob', () => {
    const thumbnail = new Blob(['cached thumbnail'])
    const [merged] = mergeCapsules(
      [capsule({ photos: [photo({ image: 'blob:expired', thumbnail })] })],
      [capsule({ photos: [photo()] })],
    )
    expect(merged.photos[0].image).toBe('/fresh-image.jpg')
    expect(merged.photos[0].thumbnail).toBe(thumbnail)
  })

  it('migrates weekly draft identity, remaps pending photos and preserves authoritative counts', () => {
    const pending = photo({
      id: 'pending', capsuleId: 'local-week', syncStatus: 'pending',
      image: new Blob(['pending']), capturedAt: '2026-08-26T12:00:00.000Z',
    })
    const cached = photo({ id: 'cached', capsuleId: 'local-week', thumbnail: new Blob(['cached']) })
    const local = capsule({ id: 'local-week', familySynced: false, photos: [cached, pending] })
    const remote = capsule({ totalPhotoCount: 8, photos: [photo({ id: 'remote' })] })
    const merged = mergeCapsules([local], [remote])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 'remote-week', totalPhotoCount: 9, familySynced: true })
    expect(merged[0].photos.map(({ id }) => id)).toEqual(['pending', 'remote', 'cached'])
    expect(merged[0].photos.every(({ capsuleId }) => capsuleId === 'remote-week')).toBe(true)
    expect(local.photos[0].capsuleId).toBe('local-week')
  })

  it('keeps unmatched pending or durable media but drops renewable URL-only stale rows', () => {
    const local = capsule({ photos: [
      photo({ id: 'pending-url', syncStatus: 'pending' }),
      photo({ id: 'durable', image: new Blob(['cached']) }),
      photo({ id: 'stale-url' }),
    ] })
    const [merged] = mergeCapsules([local], [capsule()])
    expect(merged.photos.map(({ id }) => id)).toEqual(['pending-url', 'durable'])
    expect(merged.totalPhotoCount).toBe(2)
  })

  it('does not double-count a pending photo once the remote snapshot acknowledges its ID', () => {
    const [merged] = mergeCapsules(
      [capsule({ photos: [photo({ syncStatus: 'pending', image: new Blob(['local']) })] })],
      [capsule({ photos: [photo()], totalPhotoCount: 1 })],
    )
    expect(merged.photos).toHaveLength(1)
    expect(merged.totalPhotoCount).toBe(1)
    expect(merged.photos[0].syncStatus).toBe('synced')
  })

  it('retains unrelated offline capsules and never matches a special capsule by weekStart', () => {
    const localWeek = capsule({ id: 'local-week', weekStart: '2026-08-17' })
    const special = capsule({ id: 'special', kind: 'special', familySynced: false })
    const merged = mergeCapsules([localWeek, special], [capsule()])
    expect(merged.map(({ id }) => id)).toEqual(['remote-week', 'local-week', 'special'])
    expect(merged.find(({ id }) => id === 'special')).toBe(special)
  })
})
