import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapsuleDeletionSnapshot } from './capsuleDeletionService'
import { retainCapsuleRemovals } from './capsuleRemovalState'
import { createMemoryCapsuleStore } from './capsuleStore'
import { synchronizeCapsuleSnapshot } from './capsuleSynchronization'
import type { CapsulePhoto, FamilyCapsule } from './types'

const service = vi.hoisted(() => ({
  createFamilySpecialCapsule: vi.fn(), ensureFamilyWeeklyCapsule: vi.fn(),
  fetchFamilyCapsules: vi.fn(), uploadFamilyCapsulePhoto: vi.fn(),
}))
const deletions = vi.hoisted(() => ({ fetchFamilyCapsuleDeletions: vi.fn() }))
vi.mock('./capsuleService', () => service)
vi.mock('./capsuleDeletionService', () => deletions)

const now = new Date('2026-09-12T10:00:00.000Z')
const localWeekKey = '2026-09-07'
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const weeklyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const specialId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
let sequence = 0
let scope: string

function photo(id: string, overrides: Partial<CapsulePhoto> = {}): CapsulePhoto {
  return {
    id, capsuleId: weeklyId, image: new Blob([id]), thumbnail: new Blob([id]),
    width: 900, height: 1200, thumbnailWidth: 300, thumbnailHeight: 400,
    caption: id, capturedAt: '2026-09-11T10:00:00.000Z', contributorName: 'Alice',
    ownedByCurrentUser: true, syncStatus: 'pending', ...overrides,
  }
}
function capsule(overrides: Partial<FamilyCapsule> = {}): FamilyCapsule {
  return {
    id: weeklyId, kind: 'weekly', title: 'This week', weekStart: localWeekKey,
    createdAt: '2026-09-07T00:00:00.000Z', opensAt: '2026-09-14T00:00:00.000Z',
    closesAt: '2026-09-14T00:00:00.000Z', createdByName: 'Alice', createdById: userId,
    ownedByCurrentUser: true, familySynced: true, totalPhotoCount: 0, photos: [], ...overrides,
  }
}
function setup(saved: FamilyCapsule[]) {
  const store = createMemoryCapsuleStore(saved)
  vi.spyOn(store, 'remove')
  vi.spyOn(store, 'save')
  return { store, sync: (isCurrent?: () => boolean) => synchronizeCapsuleSnapshot({
    store, now, localWeekKey, displayName: 'Alice', cacheNamespace: scope, isCurrent,
  }) }
}
function mockMarkers(markers: CapsuleDeletionSnapshot) {
  deletions.fetchFamilyCapsuleDeletions.mockResolvedValue(markers)
}

beforeEach(() => {
  vi.resetAllMocks()
  scope = `capsule-deletion-sync:${++sequence}:family`
  mockMarkers({ capsules: [], photos: [] })
  service.ensureFamilyWeeklyCapsule.mockResolvedValue({ id: weeklyId, weekStart: localWeekKey })
  service.fetchFamilyCapsules.mockResolvedValue([capsule()])
  service.createFamilySpecialCapsule.mockResolvedValue(null)
  service.uploadFamilyCapsulePhoto.mockResolvedValue(null)
})

describe('Capsule deletion synchronization', () => {
  it('prunes a legacy own pending-photo receipt before retrying uploads while retaining other photos', async () => {
    const removed = photo('removed-photo')
    const retained = photo('retained-photo')
    const { sync, store } = setup([capsule({ photos: [removed, retained], totalPhotoCount: 2 })])
    mockMarkers({ capsules: [], photos: [{ capsuleId: weeklyId, photoId: removed.id, uploaderId: userId, ownedByCurrentUser: true }] })
    const result = await sync()
    expect(service.uploadFamilyCapsulePhoto).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ itemId: retained.id }))
    expect(result.capsules[0].photos.map(({ id }) => id)).toEqual([retained.id])
    expect((await store.list())[0].photos.map(({ id }) => id)).toEqual([retained.id])
    expect(deletions.fetchFamilyCapsuleDeletions.mock.invocationCallOrder[0]).toBeLessThan(service.uploadFamilyCapsulePhoto.mock.invocationCallOrder[0]!)
  })

  it('does not recreate or reupload a cancelled special draft from cache or a stale family response', async () => {
    const removed = capsule({ id: specialId, kind: 'special', weekStart: undefined, familySynced: false,
      photos: [photo('cancelled', { capsuleId: specialId })] })
    const { sync, store } = setup([removed])
    mockMarkers({ capsules: [{ capsuleId: specialId, creatorId: userId, ownedByCurrentUser: true }], photos: [] })
    service.fetchFamilyCapsules.mockResolvedValue([capsule(), removed])
    const result = await sync()
    expect(result.capsules.map(({ id }) => id)).toEqual([weeklyId])
    expect(service.createFamilySpecialCapsule).not.toHaveBeenCalled()
    expect(service.uploadFamilyCapsulePhoto).not.toHaveBeenCalled()
    expect(store.remove).toHaveBeenCalledWith(specialId)
  })

  it('removes a deleted weekly offline alias without creating a replacement when ensure returns its shell', async () => {
    const alias = capsule({ id: `weekly-${localWeekKey}`, familySynced: false,
      photos: [photo('weekly-pending', { capsuleId: `weekly-${localWeekKey}` })] })
    const { sync, store } = setup([alias])
    mockMarkers({ capsules: [{ capsuleId: weeklyId, creatorId: userId, ownedByCurrentUser: true, weekStart: localWeekKey, wasPublished: true }], photos: [] })
    service.fetchFamilyCapsules.mockResolvedValue([])
    const result = await sync()
    expect(result).toEqual({ capsules: [], authoritativeWeeklyId: weeklyId })
    expect(await store.list()).toEqual([])
    expect(service.uploadFamilyCapsulePhoto).not.toHaveBeenCalled()
  })

  it('retains the family week after reconnecting with an unpublished offline cancellation', async () => {
    const alias = capsule({ id: `weekly-${localWeekKey}`, familySynced: false,
      photos: [photo('cancelled-draft', { capsuleId: `weekly-${localWeekKey}` })] })
    const shared = capsule({ createdById: otherId, ownedByCurrentUser: false,
      photos: [photo('family-photo', { uploaderId: otherId, ownedByCurrentUser: false, syncStatus: 'synced' })] })
    const { sync, store } = setup([alias])
    retainCapsuleRemovals(scope, { capsules: [{ capsuleId: alias.id, creatorId: userId,
      ownedByCurrentUser: true, weekStart: localWeekKey, wasPublished: false }], photos: [] })
    service.fetchFamilyCapsules.mockResolvedValue([shared])
    expect((await sync()).capsules).toEqual([shared])
    expect(await store.list()).toEqual([shared])
    expect(service.uploadFamilyCapsulePhoto).not.toHaveBeenCalled()
  })

  it('does not hide another creator’s later same-ID Capsule behind a private draft cancellation', async () => {
    const mine = capsule({ id: specialId, kind: 'special', weekStart: undefined, familySynced: false })
    const theirs = { ...mine, createdById: otherId, createdByName: 'Bob', ownedByCurrentUser: false, familySynced: true }
    const { sync } = setup([mine])
    mockMarkers({ capsules: [{ capsuleId: specialId, creatorId: userId, ownedByCurrentUser: true }], photos: [] })
    service.fetchFamilyCapsules.mockResolvedValue([capsule(), theirs])
    const result = await sync()
    expect(result.capsules.find(({ id }) => id === specialId)).toEqual(theirs)
  })

  it('keeps a different uploader’s same-ID photo when the original uploader cancelled theirs', async () => {
    const theirs = photo('same-id', { uploaderId: otherId, ownedByCurrentUser: false, contributorName: 'Bob', syncStatus: 'synced' })
    const { sync } = setup([capsule({ photos: [theirs] })])
    mockMarkers({ capsules: [], photos: [{ capsuleId: weeklyId, photoId: theirs.id, uploaderId: userId, ownedByCurrentUser: true }] })
    const result = await sync()
    expect(result.capsules[0].photos).toEqual([theirs])
    expect(service.uploadFamilyCapsulePhoto).not.toHaveBeenCalled()
  })

  it('preserves durable originals and skips uncertain remote writes if deletion metadata cannot load', async () => {
    const original = capsule({ photos: [photo('offline')] })
    const { sync, store } = setup([original])
    deletions.fetchFamilyCapsuleDeletions.mockRejectedValue(new Error('deletion feed unavailable'))
    const result = await sync()
    expect(result.capsules).toEqual([original])
    expect(await store.list()).toEqual([original])
    expect(store.remove).not.toHaveBeenCalled()
    expect(service.uploadFamilyCapsulePhoto).not.toHaveBeenCalled()
  })

  it('still applies a confirmed local receipt when the next deletion metadata read fails', async () => {
    const removed = capsule({ id: specialId, kind: 'special', weekStart: undefined })
    const { sync, store } = setup([capsule(), removed])
    retainCapsuleRemovals(scope, { capsules: [{ capsuleId: specialId, creatorId: userId, ownedByCurrentUser: true }], photos: [] })
    deletions.fetchFamilyCapsuleDeletions.mockRejectedValue(new Error('offline'))
    const result = await sync()
    expect(result.capsules.map(({ id }) => id)).toEqual([weeklyId])
    expect(store.remove).toHaveBeenCalledWith(specialId)
  })

  it('does not retain another session’s returned markers or mutate its store after account switch', async () => {
    const original = capsule({ photos: [photo('private')] })
    const { sync, store } = setup([original])
    let current = true
    deletions.fetchFamilyCapsuleDeletions.mockImplementation(async () => {
      current = false
      return { capsules: [{ capsuleId: weeklyId, creatorId: userId, ownedByCurrentUser: true }], photos: [] }
    })
    await expect(sync(() => current)).rejects.toThrow('family session has ended')
    expect(store.save).not.toHaveBeenCalled()
    expect(store.remove).not.toHaveBeenCalled()
  })
})
