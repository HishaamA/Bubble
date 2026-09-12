import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapsuleSession, CapsuleSyncResult } from './capsuleSessionCache'
import type { CapsulePhoto, CapsuleStore, FamilyCapsule } from './types'
import { canDeleteCapsule, removeCapsuleContent } from './capsuleRemovalActions'
import { readCapsuleRemovals } from './capsuleRemovalState'

const mocks = vi.hoisted(() => ({
  deleteCapsule: vi.fn(), deletePhoto: vi.fn(), getSession: vi.fn(), retainDraft: vi.fn(), changed: vi.fn(),
}))
vi.mock('./capsuleDeletionService', () => ({ deleteFamilyCapsule: mocks.deleteCapsule, deleteFamilyCapsulePhoto: mocks.deletePhoto }))
vi.mock('./capsuleSessionCache', () => ({ getCapsuleSession: mocks.getSession, retainCapsuleSessionDraft: mocks.retainDraft }))
vi.mock('./capsuleChanges', () => ({ notifyLocalCapsulesChanged: mocks.changed }))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}
function photo(id: string, overrides: Partial<CapsulePhoto> = {}): CapsulePhoto {
  return { id, capsuleId: 'capsule-a', image: 'fake-image', thumbnail: 'fake-thumbnail', width: 2, height: 1,
    caption: 'Test photo', capturedAt: '2026-09-12T08:00:00Z', contributorName: 'Test member',
    uploaderId: 'uploader-a', ownedByCurrentUser: true, ...overrides }
}
function capsule(overrides: Partial<FamilyCapsule> = {}): FamilyCapsule {
  return { id: 'capsule-a', kind: 'special', title: 'Test Capsule', createdAt: '2026-09-01T08:00:00Z',
    closesAt: '2026-09-12T08:00:00Z', opensAt: '2026-09-12T08:00:00Z', createdByName: 'Test member',
    createdById: 'creator-a', ownedByCurrentUser: true, familySynced: true,
    photos: [photo('photo-a'), photo('photo-b', { uploaderId: 'uploader-b', ownedByCurrentUser: false })], ...overrides }
}
function memoryStore(seed: FamilyCapsule[]) {
  const records = new Map(seed.map(item => [item.id, item]))
  return {
    list: vi.fn(async () => [...records.values()]),
    save: vi.fn(async (item: FamilyCapsule) => { records.set(item.id, item) }),
    remove: vi.fn(async (id: string) => { records.delete(id) }),
  } satisfies CapsuleStore
}

let sequence = 0
let scope: string
let session: CapsuleSession
let original: FamilyCapsule
let store: ReturnType<typeof memoryStore>
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  scope = `removal-actions:family:${++sequence}`
  original = capsule()
  store = memoryStore([original])
  session = { store, result: { capsules: [original], authoritativeWeeklyId: 'server-week' },
    refreshedAt: 0, observedAt: 0, weekKey: '', inFlight: null, disposed: false }
  mocks.getSession.mockReturnValue(session)
  mocks.deleteCapsule.mockResolvedValue(undefined)
  mocks.deletePhoto.mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('Capsule removal actions', () => {
  it('allows known owners and offline drafts but rejects unowned synced or unknown Capsules', () => {
    expect(canDeleteCapsule(capsule())).toBe(true)
    expect(canDeleteCapsule(capsule({ ownedByCurrentUser: undefined, familySynced: false }))).toBe(true)
    expect(canDeleteCapsule(capsule({ ownedByCurrentUser: false }))).toBe(false)
    expect(canDeleteCapsule(capsule({ ownedByCurrentUser: undefined, familySynced: undefined }))).toBe(false)
  })

  it.each(['foreign Capsule', 'foreign photo', 'missing photo'])('denies a %s before remote or local mutation', async scenario => {
    const target = scenario === 'foreign Capsule' ? capsule({ ownedByCurrentUser: false }) : original
    const photoId = scenario === 'foreign photo' ? 'photo-b' : scenario === 'missing photo' ? 'missing' : undefined
    session.result = { capsules: [target], authoritativeWeeklyId: '' }
    session.store = memoryStore([target])
    await expect(removeCapsuleContent({ scope, capsule: target, photoId })).rejects.toThrow('Only the original uploader')
    expect(mocks.deleteCapsule).not.toHaveBeenCalled()
    expect(mocks.deletePhoto).not.toHaveBeenCalled()
    expect(mocks.retainDraft).not.toHaveBeenCalled()
    expect(mocks.changed).not.toHaveBeenCalled()
    expect(readCapsuleRemovals(scope)).toEqual({ capsules: [], photos: [] })
  })

  it('waits for confirmed remote photo deletion before updating storage, warm data, and widgets', async () => {
    const remote = deferred()
    const widgetChanged = vi.fn()
    window.addEventListener('bubble:widget-data-changed', widgetChanged)
    mocks.deletePhoto.mockReturnValue(remote.promise)
    try {
      const pending = removeCapsuleContent({ scope, capsule: original, photoId: 'photo-a' })
      await vi.waitFor(() => expect(mocks.deletePhoto).toHaveBeenCalledExactlyOnceWith(original.id, 'photo-a', scope))
      expect(store.save).not.toHaveBeenCalled()
      expect(store.remove).not.toHaveBeenCalled()
      expect(readCapsuleRemovals(scope)).toEqual({ capsules: [], photos: [] })
      remote.resolve()
      await pending
      expect((await store.list())[0].photos).toEqual([original.photos[1]])
      expect(mocks.retainDraft).toHaveBeenCalledWith(session, expect.objectContaining({
        authoritativeWeeklyId: 'server-week', capsules: [expect.objectContaining({ photos: [original.photos[1]] })],
      }))
      expect(readCapsuleRemovals(scope).photos).toEqual([{ capsuleId: original.id, photoId: 'photo-a', uploaderId: 'uploader-a', ownedByCurrentUser: true, wasPublished: false }])
      expect(mocks.changed).toHaveBeenCalledExactlyOnceWith(scope)
      expect(widgetChanged).toHaveBeenCalledOnce()
    } finally { window.removeEventListener('bubble:widget-data-changed', widgetChanged) }
  })

  it('allows an uploader to remove their photo without owning the containing Capsule', async () => {
    const target = capsule({ ownedByCurrentUser: false, createdById: 'other-creator' })
    session.result = { capsules: [target], authoritativeWeeklyId: '' }
    session.store = memoryStore([target])
    await removeCapsuleContent({ scope, capsule: target, photoId: 'photo-a' })
    expect(mocks.deletePhoto).toHaveBeenCalledExactlyOnceWith(target.id, 'photo-a', scope)
    expect(mocks.deleteCapsule).not.toHaveBeenCalled()
  })

  it('leaves all local consumers untouched when server deletion rejects', async () => {
    mocks.deleteCapsule.mockRejectedValue(new Error('Family is offline'))
    await expect(removeCapsuleContent({ scope, capsule: original })).rejects.toThrow('Family is offline')
    expect(await store.list()).toEqual([original])
    expect(store.save).not.toHaveBeenCalled()
    expect(store.remove).not.toHaveBeenCalled()
    expect(mocks.retainDraft).not.toHaveBeenCalled()
    expect(mocks.changed).not.toHaveBeenCalled()
    expect(readCapsuleRemovals(scope)).toEqual({ capsules: [], photos: [] })
  })

  it('does not mutate the previous family when its server response arrives after disposal', async () => {
    const remote = deferred()
    mocks.deleteCapsule.mockReturnValue(remote.promise)
    const pending = removeCapsuleContent({ scope, capsule: original })
    const rejected = expect(pending).rejects.toThrow('This family session has ended.')
    await vi.waitFor(() => expect(mocks.deleteCapsule).toHaveBeenCalledOnce())
    session.disposed = true
    remote.resolve()
    await rejected
    expect(store.remove).not.toHaveBeenCalled()
    expect(mocks.retainDraft).not.toHaveBeenCalled()
    expect(mocks.changed).not.toHaveBeenCalled()
    expect(readCapsuleRemovals(scope)).toEqual({ capsules: [], photos: [] })
  })

  it('rejects an already disposed session before attempting deletion', async () => {
    session.disposed = true
    await expect(removeCapsuleContent({ scope, capsule: original })).rejects.toThrow('This family session has ended.')
    expect(mocks.deleteCapsule).not.toHaveBeenCalled()
    expect(mocks.deletePhoto).not.toHaveBeenCalled()
    expect(store.remove).not.toHaveBeenCalled()
  })

  it.each(['signed-out', 'owner:no-family', 'family-weekly-draft'])('removes a genuinely local draft without a remote request (%s)', async kind => {
    const localScope = kind === 'family-weekly-draft' ? scope : kind
    const target = capsule({ id: `weekly-draft-${sequence}`, familySynced: false, kind: 'weekly', weekStart: '2026-09-07' })
    session.result = { capsules: [target], authoritativeWeeklyId: '' }
    session.store = memoryStore([target])
    await removeCapsuleContent({ scope: localScope, capsule: target })
    expect(mocks.deleteCapsule).not.toHaveBeenCalled()
    expect(mocks.deletePhoto).not.toHaveBeenCalled()
    expect(await session.store.list()).toEqual([])
    expect(readCapsuleRemovals(localScope).capsules).toEqual([expect.objectContaining({ capsuleId: target.id, weekStart: target.weekStart })])
  })

  it.each(['Capsule', 'photo'] as const)('uses the canonical weekly ID after a pending refresh before deleting the %s', async noun => {
    const draft = capsule({ id: 'weekly-local', familySynced: false, kind: 'weekly', weekStart: '2026-09-07' })
    const canonical = capsule({ id: 'canonical-weekly', kind: 'weekly', weekStart: draft.weekStart,
      photos: draft.photos.map(item => ({ ...item, capsuleId: 'canonical-weekly' })) })
    const refresh = deferred<CapsuleSyncResult>()
    session.result = { capsules: [draft], authoritativeWeeklyId: '' }
    session.store = memoryStore([draft])
    session.inFlight = refresh.promise
    const pending = removeCapsuleContent({ scope, capsule: draft, photoId: noun === 'photo' ? 'photo-a' : undefined })
    expect(mocks.deleteCapsule).not.toHaveBeenCalled()
    expect(mocks.deletePhoto).not.toHaveBeenCalled()
    session.result = { capsules: [canonical], authoritativeWeeklyId: canonical.id }
    session.store = memoryStore([canonical])
    refresh.resolve(session.result)
    await pending
    if (noun === 'photo') {
      expect(mocks.deletePhoto).toHaveBeenCalledExactlyOnceWith(canonical.id, 'photo-a', scope)
      expect((await session.store.list())[0].photos.map(item => item.id)).toEqual(['photo-b'])
    } else {
      expect(mocks.deleteCapsule).toHaveBeenCalledExactlyOnceWith(canonical.id, scope)
      expect(await session.store.list()).toEqual([])
    }
  })
})
