import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyCapsuleRemovals, readCapsuleRemovals, retainCapsuleRemovals, withCapsuleRemovals } from './capsuleRemovalState'
import type { CapsulePhoto, CapsuleStore, FamilyCapsule } from './types'

let sequence = 0
let scope: string
const storageKey = (value: string) => `bubble:capsule-removals:v1:${encodeURIComponent(value)}`
function photo(id: string, overrides: Partial<CapsulePhoto> = {}): CapsulePhoto {
  return { id, capsuleId: 'capsule-a', image: 'fake-image', thumbnail: 'fake-thumbnail', width: 2, height: 1,
    caption: 'Test photo', capturedAt: '2026-09-12T08:00:00Z', contributorName: 'Test member',
    uploaderId: 'uploader-a', ownedByCurrentUser: true, ...overrides }
}
function capsule(overrides: Partial<FamilyCapsule> = {}): FamilyCapsule {
  return { id: 'capsule-a', kind: 'special', title: 'Test Capsule', createdAt: '2026-09-01T08:00:00Z',
    closesAt: '2026-09-12T08:00:00Z', opensAt: '2026-09-12T08:00:00Z', createdByName: 'Test member',
    createdById: 'creator-a', ownedByCurrentUser: true,
    familySynced: true, photos: [photo('photo-a'), photo('photo-b')], ...overrides }
}
beforeEach(() => { localStorage.clear(); scope = `removal-state:family:${++sequence}` })
afterEach(() => vi.restoreAllMocks())

describe('Capsule removal receipts', () => {
  it.each([false, true])('prunes legacy foreign parents only for published receipts (%s)', wasPublished => {
    const legacy = capsule({ createdById: undefined, ownedByCurrentUser: undefined })
    retainCapsuleRemovals(scope, { capsules: [{ capsuleId: legacy.id, creatorId: 'creator-a', ownedByCurrentUser: false, wasPublished }], photos: [] })
    expect(applyCapsuleRemovals([legacy], scope)).toEqual(wasPublished ? [] : [legacy])
  })

  it.each([false, true])('prunes legacy foreign photo bytes only for published receipts (%s)', wasPublished => {
    const legacy = capsule({ photos: [photo('old-photo', { uploaderId: undefined, ownedByCurrentUser: false })] })
    retainCapsuleRemovals(scope, { capsules: [], photos: [{ capsuleId: legacy.id, photoId: 'old-photo', uploaderId: 'uploader-a', ownedByCurrentUser: false, wasPublished }] })
    expect(applyCapsuleRemovals([legacy], scope)[0].photos).toHaveLength(wasPublished ? 0 : 1)
  })

  it('ignores malformed persisted receipts and validates the required marker fields', () => {
    localStorage.setItem(storageKey(scope), '{invalid')
    expect(readCapsuleRemovals(scope)).toEqual({ capsules: [], photos: [] })
    localStorage.setItem(storageKey(scope), JSON.stringify({ capsules: [null, {}, { capsuleId: 'capsule-a', ownedByCurrentUser: false }],
      photos: [null, { capsuleId: 'capsule-a', photoId: 'a' }, { capsuleId: 'capsule-a', photoId: 'b', ownedByCurrentUser: false }] }))
    expect(readCapsuleRemovals(scope)).toEqual({
      capsules: [{ capsuleId: 'capsule-a', ownedByCurrentUser: false }],
      photos: [{ capsuleId: 'capsule-a', photoId: 'b', ownedByCurrentUser: false }],
    })
  })

  it('merges durable receipts without losing previously deleted items or uploader distinctions', () => {
    const first = { capsules: [{ capsuleId: 'old', ownedByCurrentUser: true }],
      photos: [{ capsuleId: 'capsule-a', photoId: 'shared-id', uploaderId: 'uploader-a', ownedByCurrentUser: true }] }
    retainCapsuleRemovals(scope, first)
    retainCapsuleRemovals(scope, first)
    retainCapsuleRemovals(scope, { capsules: [{ capsuleId: 'new', ownedByCurrentUser: false }],
      photos: [{ capsuleId: 'capsule-a', photoId: 'shared-id', uploaderId: 'uploader-b', ownedByCurrentUser: false }] })
    expect(readCapsuleRemovals(scope).capsules.map(item => item.capsuleId)).toEqual(['old', 'new'])
    expect(readCapsuleRemovals(scope).photos.map(item => item.uploaderId)).toEqual(['uploader-a', 'uploader-b'])
    expect(JSON.parse(localStorage.getItem(storageKey(scope))!)).toEqual(readCapsuleRemovals(scope))
  })

  it('removes a Capsule ID and its matching weekly alias, but leaves other weeks and special Capsules', () => {
    const weekly = capsule({ id: 'canonical-week', kind: 'weekly', weekStart: '2026-09-07' })
    const otherWeek = capsule({ id: 'next-week', kind: 'weekly', weekStart: '2026-09-14' })
    const special = capsule({ id: 'special', weekStart: '2026-09-07' })
    retainCapsuleRemovals(scope, { capsules: [{ capsuleId: 'capsule-a', creatorId: 'creator-a', ownedByCurrentUser: false },
      { capsuleId: 'weekly-local', weekStart: '2026-09-07', ownedByCurrentUser: true, wasPublished: true }], photos: [] })
    expect(applyCapsuleRemovals([capsule(), weekly, otherWeek, special], scope)).toEqual([otherWeek, special])
  })

  it.each([false, undefined])('keeps a shared weekly Capsule when an offline draft was cancelled (%s)', wasPublished => {
    const draft = capsule({ id: 'weekly-2026-09-07', kind: 'weekly', weekStart: '2026-09-07',
      createdById: undefined, familySynced: false })
    const shared = capsule({ id: 'server-week', kind: 'weekly', weekStart: draft.weekStart,
      createdById: 'other-member', ownedByCurrentUser: false })
    retainCapsuleRemovals(scope, { capsules: [{ capsuleId: draft.id, weekStart: draft.weekStart,
      ownedByCurrentUser: true, wasPublished }], photos: [] })
    expect(applyCapsuleRemovals([draft, shared], scope)).toEqual([shared])
  })

  it('uses published weekly receipts to remove the server Capsule and its local alias', () => {
    const shared = capsule({ id: 'server-week', kind: 'weekly', weekStart: '2026-09-07',
      createdById: 'other-member', ownedByCurrentUser: false })
    const draft = capsule({ id: 'weekly-2026-09-07', kind: 'weekly', weekStart: shared.weekStart,
      createdById: undefined, familySynced: false })
    retainCapsuleRemovals(scope, { capsules: [{ capsuleId: shared.id, creatorId: shared.createdById,
      weekStart: shared.weekStart, ownedByCurrentUser: false, wasPublished: true }], photos: [] })
    expect(applyCapsuleRemovals([shared, draft], scope)).toEqual([])
  })

  it('does not apply an explicit different creator receipt even when both records say owned', () => {
    retainCapsuleRemovals(scope, { capsules: [{ capsuleId: 'capsule-a', creatorId: 'creator-b', ownedByCurrentUser: true }], photos: [] })
    const target = capsule()
    expect(applyCapsuleRemovals([target], scope)[0]).toBe(target)
    expect(applyCapsuleRemovals([capsule({ createdById: undefined })], scope)).toEqual([])
  })

  it('applies family-wide photo receipts only to the matching Capsule, photo and uploader', () => {
    const target = capsule({ photos: [
      photo('same-id', { uploaderId: 'uploader-a', ownedByCurrentUser: false }),
      photo('same-id', { uploaderId: 'uploader-b', ownedByCurrentUser: true }),
      photo('other-id', { uploaderId: 'uploader-a', ownedByCurrentUser: false }),
    ] })
    const otherCapsule = capsule({ id: 'capsule-b', photos: [photo('same-id', { capsuleId: 'capsule-b' })] })
    retainCapsuleRemovals(scope, { capsules: [], photos: [
      { capsuleId: 'capsule-a', photoId: 'same-id', uploaderId: 'uploader-a', ownedByCurrentUser: false },
    ] })
    const result = applyCapsuleRemovals([target, otherCapsule], scope)
    expect(result[0].photos.map(item => [item.id, item.uploaderId])).toEqual([['same-id', 'uploader-b'], ['other-id', 'uploader-a']])
    expect(result[1]).toBe(otherCapsule)
    expect(target.photos).toHaveLength(3)
  })

  it('uses legacy ownership fallback only when the photo has no explicit uploader ID', () => {
    retainCapsuleRemovals(scope, { capsules: [], photos: [
      { capsuleId: 'capsule-a', photoId: 'same-id', uploaderId: 'uploader-a', ownedByCurrentUser: true },
    ] })
    const target = capsule({ photos: [
      photo('same-id', { uploaderId: 'uploader-b', ownedByCurrentUser: true }),
      photo('same-id', { uploaderId: undefined, ownedByCurrentUser: true }),
      photo('same-id', { uploaderId: undefined, ownedByCurrentUser: false }),
    ] })
    expect(applyCapsuleRemovals([target], scope)[0].photos).toEqual([target.photos[0], target.photos[2]])
  })

  it('keeps family/account scopes separate and preserves unmodified object identities', () => {
    const original = capsule()
    retainCapsuleRemovals(scope, { capsules: [{ capsuleId: original.id, creatorId: 'creator-a', ownedByCurrentUser: true }], photos: [] })
    expect(applyCapsuleRemovals([original], scope)).toEqual([])
    expect(applyCapsuleRemovals([original], `${scope}:other-family`)[0]).toBe(original)
    expect(applyCapsuleRemovals([original], `other-account:${scope}`)[0]).toBe(original)
  })

  it.each([undefined, 20, 0])('adjusts total counts without undercounting visible photos (%s)', totalPhotoCount => {
    const target = capsule({ totalPhotoCount })
    retainCapsuleRemovals(scope, { capsules: [], photos: [{ capsuleId: target.id, photoId: 'photo-a', uploaderId: 'uploader-a', ownedByCurrentUser: true }] })
    const [result] = applyCapsuleRemovals([target], scope)
    expect(result.photos.map(item => item.id)).toEqual(['photo-b'])
    expect(result.totalPhotoCount).toBe(totalPhotoCount === 20 ? 19 : 1)
    expect(target.photos).toHaveLength(2)
  })

  it('retains a confirmed server receipt in memory even if persistence is full', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
    expect(() => retainCapsuleRemovals(scope, { capsules: [{ capsuleId: 'capsule-a', creatorId: 'creator-a', ownedByCurrentUser: true }], photos: [] })).not.toThrow()
    expect(applyCapsuleRemovals([capsule()], scope)).toEqual([])
  })

  it('filters stale reads and saves so removed Capsules and photos cannot be resurrected', async () => {
    const deleted = capsule({ id: 'deleted-capsule' })
    const edited = capsule()
    const store: CapsuleStore = { list: vi.fn().mockResolvedValue([deleted, edited]), save: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) }
    const protectedStore = withCapsuleRemovals(store, scope)
    retainCapsuleRemovals(scope, { capsules: [{ capsuleId: deleted.id, creatorId: 'creator-a', ownedByCurrentUser: true }],
      photos: [{ capsuleId: edited.id, photoId: 'photo-a', uploaderId: 'uploader-a', ownedByCurrentUser: true }] })
    expect((await protectedStore.list()).map(item => item.id)).toEqual([edited.id])
    await protectedStore.save(deleted)
    expect(store.remove).toHaveBeenCalledExactlyOnceWith(deleted.id)
    expect(store.save).not.toHaveBeenCalled()
    await protectedStore.save(edited)
    expect(store.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: edited.id, photos: [edited.photos[1]], totalPhotoCount: 1 }))
    await protectedStore.remove('explicit-remove')
    expect(store.remove).toHaveBeenLastCalledWith('explicit-remove')
  })

  it('applies receipts received while a stale storage read is still pending', async () => {
    let resolve!: (value: FamilyCapsule[]) => void
    const store: CapsuleStore = { list: () => new Promise(done => { resolve = done }), save: vi.fn(), remove: vi.fn() }
    const read = withCapsuleRemovals(store, scope).list()
    retainCapsuleRemovals(scope, { capsules: [{ capsuleId: 'capsule-a', creatorId: 'creator-a', ownedByCurrentUser: false }], photos: [] })
    resolve([capsule()])
    expect(await read).toEqual([])
  })
})
