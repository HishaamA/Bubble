import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCurrentWeeklyCapsule } from './capsuleReconciliation'
import { createMemoryCapsuleStore } from './capsuleStore'
import { synchronizeCapsuleSnapshot } from './capsuleSynchronization'
import type { CapsulePhoto, FamilyCapsule } from './types'

const service = vi.hoisted(() => ({
  createFamilySpecialCapsule: vi.fn(),
  ensureFamilyWeeklyCapsule: vi.fn(),
  fetchFamilyCapsules: vi.fn(),
  uploadFamilyCapsulePhoto: vi.fn(),
}))
vi.mock('./capsuleService', () => service)

const now = new Date(2026, 7, 29, 12)
const localWeekKey = '2026-08-24'

function week(overrides: Partial<FamilyCapsule> = {}): FamilyCapsule {
  return { ...createCurrentWeeklyCapsule(now, 'Simreen'), ...overrides }
}

function photo(overrides: Partial<CapsulePhoto> = {}): CapsulePhoto {
  return {
    id: 'pending-photo',
    capsuleId: 'remote-week',
    image: new Blob(['image'], { type: 'image/jpeg' }),
    thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
    width: 900, height: 1200, thumbnailWidth: 300, thumbnailHeight: 400,
    caption: 'Together', capturedAt: '2026-08-28T10:00:00.000Z',
    contributorName: 'Simreen', ownedByCurrentUser: true, syncStatus: 'pending',
    ...overrides,
  }
}

function setup(saved: FamilyCapsule[] = []) {
  const store = createMemoryCapsuleStore(saved)
  vi.spyOn(store, 'save')
  vi.spyOn(store, 'remove')
  return {
    store,
    synchronize: (isCurrent?: () => boolean) => synchronizeCapsuleSnapshot({
      store, now, localWeekKey, displayName: 'Simreen', isCurrent,
    }),
  }
}

const remoteWeek = week({ id: 'remote-week', familySynced: true })

beforeEach(() => {
  vi.resetAllMocks()
  service.ensureFamilyWeeklyCapsule.mockResolvedValue({ id: remoteWeek.id, weekStart: localWeekKey })
  service.fetchFamilyCapsules.mockResolvedValue([remoteWeek])
  service.createFamilySpecialCapsule.mockResolvedValue(null)
  service.uploadFamilyCapsulePhoto.mockResolvedValue(null)
})

describe('capsule synchronization', () => {
  it('creates and persists an offline weekly fallback when no family context is available', async () => {
    service.ensureFamilyWeeklyCapsule.mockResolvedValue(null)
    const { synchronize, store } = setup()
    const result = await synchronize()
    expect(result).toEqual({ capsules: [week()], authoritativeWeeklyId: 'weekly-2026-08-24' })
    expect(await store.list()).toEqual(result.capsules)
    expect(service.fetchFamilyCapsules).not.toHaveBeenCalled()
  })

  it('reuses a durable offline week and archive when the server is unreachable', async () => {
    service.ensureFamilyWeeklyCapsule.mockRejectedValue(new Error('Offline'))
    const archive = week({ id: 'archive', weekStart: '2026-08-17', createdAt: '2026-08-17T00:00:00.000Z' })
    const saved = week({ id: 'existing-week', photos: [photo()] })
    const { synchronize, store } = setup([archive, saved])
    const result = await synchronize()
    expect(result.authoritativeWeeklyId).toBe('existing-week')
    expect(result.capsules.map(({ id }) => id)).toEqual(['existing-week', 'archive'])
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('removes the old weekly identity only after reconciling its durable pending photos', async () => {
    const pending = photo({ capsuleId: 'weekly-2026-08-24' })
    const { synchronize, store } = setup([week({ photos: [pending] })])
    const result = await synchronize()
    expect(result.authoritativeWeeklyId).toBe('remote-week')
    expect(result.capsules).toHaveLength(1)
    expect(result.capsules[0].photos[0]).toMatchObject({ id: pending.id, capsuleId: 'remote-week', syncStatus: 'pending' })
    expect(result.capsules[0].photos[0].image).toBe(pending.image)
    expect(store.remove).toHaveBeenCalledExactlyOnceWith('weekly-2026-08-24')
    expect(service.fetchFamilyCapsules).toHaveBeenCalledTimes(1)
  })

  it('creates special drafts before uploading their photos, then renews remote metadata', async () => {
    const pending = photo({ capsuleId: 'local-special' })
    const special = week({ id: 'local-special', kind: 'special', title: 'Demo day', photos: [pending] })
    const remoteSpecial = { ...special, id: 'remote-special', familySynced: true, photos: [photo({
      id: 'server-photo', capsuleId: 'remote-special', syncStatus: 'synced',
      image: '/renewed-image', thumbnail: '/renewed-thumbnail', caption: 'Server caption',
    })] }
    service.createFamilySpecialCapsule.mockResolvedValue('remote-special')
    service.uploadFamilyCapsulePhoto.mockResolvedValue('server-photo')
    service.fetchFamilyCapsules.mockResolvedValueOnce([remoteWeek]).mockResolvedValueOnce([remoteWeek, remoteSpecial])
    const { synchronize, store } = setup([special])
    const result = await synchronize()
    expect(service.createFamilySpecialCapsule).toHaveBeenCalledExactlyOnceWith(special.title, special.opensAt, special.id)
    expect(service.uploadFamilyCapsulePhoto).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      capsuleId: 'remote-special', itemId: pending.id, capturedAt: pending.capturedAt,
    }))
    expect(service.createFamilySpecialCapsule.mock.invocationCallOrder[0])
      .toBeLessThan(service.uploadFamilyCapsulePhoto.mock.invocationCallOrder[0])
    const synced = result.capsules.find(({ id }) => id === 'remote-special')!
    expect(synced.photos[0]).toMatchObject({ id: 'server-photo', caption: 'Server caption', syncStatus: 'synced' })
    expect(synced.photos[0].image).toBe(pending.image)
    expect(store.remove).toHaveBeenCalledWith('local-special')
    expect(service.fetchFamilyCapsules).toHaveBeenCalledTimes(2)
  })

  it('retains a failed special draft while continuing to synchronize independent drafts', async () => {
    const first = week({ id: 'first', kind: 'special', photos: [photo({ capsuleId: 'first' })] })
    const second = week({ id: 'second', kind: 'special', photos: [photo({ capsuleId: 'second' })] })
    service.createFamilySpecialCapsule.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce('remote-second')
    const { synchronize } = setup([first, second])
    const result = await synchronize()
    expect(result.capsules.find(({ id }) => id === 'first')).toMatchObject({ familySynced: false })
    expect(result.capsules.find(({ id }) => id === 'remote-second')).toMatchObject({ familySynced: true })
    expect(service.uploadFamilyCapsulePhoto).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ capsuleId: 'remote-second' }))
  })

  it('persists successful uploads and keeps failed photos pending when signed-URL refresh fails', async () => {
    const first = photo({ id: 'first' })
    const second = photo({ id: 'second' })
    service.uploadFamilyCapsulePhoto.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce('synced-second')
    service.fetchFamilyCapsules.mockResolvedValueOnce([remoteWeek]).mockRejectedValueOnce(new Error('Refresh failed'))
    const { synchronize, store } = setup([week({ id: 'remote-week', photos: [first, second] })])
    const result = await synchronize()
    expect(result.capsules[0].photos.map(({ id, syncStatus }) => ({ id, syncStatus }))).toEqual([
      { id: 'first', syncStatus: 'pending' }, { id: 'synced-second', syncStatus: 'synced' },
    ])
    expect(result.capsules[0].photos[1].image).toBe(second.image)
    expect(await store.list()).toEqual(result.capsules)
  })

  it('does not retry unlocked, unshared, already-synced, URL-only or incomplete media', async () => {
    const candidates = [
      photo({ id: 'eligible' }),
      photo({ id: 'synced', syncStatus: 'synced' }),
      photo({ id: 'url-image', image: '/image.jpg' }),
      photo({ id: 'url-thumbnail', thumbnail: '/thumbnail.jpg' }),
      photo({ id: 'no-width', thumbnailWidth: undefined }),
      photo({ id: 'no-height', thumbnailHeight: undefined }),
    ]
    const sealed = { ...remoteWeek, photos: candidates }
    const opened = week({ id: 'opened', kind: 'special', familySynced: true, opensAt: now.toISOString(), photos: [photo()] })
    const unshared = week({ id: 'unshared', kind: 'special', familySynced: false, photos: [photo()] })
    service.fetchFamilyCapsules.mockResolvedValue([sealed, opened])
    const { synchronize } = setup([unshared])
    await synchronize()
    expect(service.uploadFamilyCapsulePhoto).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ itemId: 'eligible' }))
    expect(service.fetchFamilyCapsules).toHaveBeenCalledTimes(1)
  })

  it.each(['local-read', 'weekly-request', 'family-fetch', 'draft-write', 'photo-write', 'final-fetch'] as const)(
    'rejects an ended family session after %s without persisting into its store',
    async (phase) => {
      let current = true
      const pending = photo({ capsuleId: 'local-special' })
      const special = week({ id: 'local-special', kind: 'special', photos: [pending] })
      const { synchronize, store } = setup([special])
      service.createFamilySpecialCapsule.mockResolvedValue('remote-special')
      service.uploadFamilyCapsulePhoto.mockResolvedValue('remote-photo')
      if (phase === 'local-read') {
        vi.spyOn(store, 'list').mockImplementationOnce(async () => { current = false; return [special] })
      } else if (phase === 'weekly-request') {
        service.ensureFamilyWeeklyCapsule.mockImplementationOnce(async () => { current = false; return remoteWeek })
      } else if (phase === 'family-fetch') {
        service.fetchFamilyCapsules.mockImplementationOnce(async () => { current = false; return [remoteWeek] })
      } else if (phase === 'draft-write') {
        service.createFamilySpecialCapsule.mockImplementationOnce(async () => { current = false; return 'remote-special' })
      } else if (phase === 'photo-write') {
        service.uploadFamilyCapsulePhoto.mockImplementationOnce(async () => { current = false; return 'remote-photo' })
      } else {
        service.fetchFamilyCapsules.mockResolvedValueOnce([remoteWeek])
          .mockImplementationOnce(async () => { current = false; return [remoteWeek] })
      }
      await expect(synchronize(() => current)).rejects.toThrow('This family session has ended.')
      expect(store.save).not.toHaveBeenCalled()
      expect(store.remove).not.toHaveBeenCalled()
      if (phase !== 'photo-write' && phase !== 'final-fetch') {
        expect(service.uploadFamilyCapsulePhoto).not.toHaveBeenCalled()
      }
    },
  )

  it('surfaces local persistence failures instead of claiming a durable successful sync', async () => {
    const { synchronize, store } = setup()
    vi.mocked(store.save).mockRejectedValue(new Error('Storage full'))
    await expect(synchronize()).rejects.toThrow('Storage full')
  })
})
