import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  capsuleDatabaseNameForSubject,
  createMemoryCapsuleStore,
  createResilientCapsuleStore,
  hydrateCapsuleFromIndexedDb,
  serializeCapsuleForIndexedDb,
} from './capsuleStore'
import type { CapsuleStore, FamilyCapsule } from './types'

function capsuleWithSources(image: Blob | string, thumbnail: Blob | string): FamilyCapsule {
  return {
    id: 'weekly-2026-08-24',
    kind: 'weekly',
    title: 'This week',
    weekStart: '2026-08-24',
    createdAt: '2026-08-24T00:00:00.000Z',
    closesAt: '2026-08-31T00:00:00.000Z',
    opensAt: '2026-08-31T00:00:00.000Z',
    createdByName: 'Simreen',
    photos: [{
      id: 'photo-one',
      capsuleId: 'weekly-2026-08-24',
      image,
      thumbnail,
      width: 1200,
      height: 1600,
      thumbnailWidth: 420,
      thumbnailHeight: 560,
      caption: 'Breakfast',
      capturedAt: '2026-08-28T08:00:00.000Z',
      contributorName: 'Simreen',
      ownedByCurrentUser: true,
      syncStatus: 'pending',
    }],
    totalPhotoCount: 1,
    familySynced: false,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Capsule storage namespace', () => {
  it('separates the same account cache across different families', () => {
    const firstFamily = capsuleDatabaseNameForSubject('user_simreen:family_a')
    const secondFamily = capsuleDatabaseNameForSubject('user_simreen:family_b')

    expect(firstFamily).not.toBe(secondFamily)
    expect(firstFamily).toContain('user_simreen%3Afamily_a')
    expect(secondFamily).toContain('user_simreen%3Afamily_b')
  })
})

describe('Capsule image persistence', () => {
  it('restores the actual image bytes after an IndexedDB app restart', async () => {
    const capsule = capsuleWithSources(
      new Blob(['full-after-restart'], { type: 'image/jpeg' }),
      new Blob(['thumb-after-restart'], { type: 'image/webp' }),
    )

    const persisted = await serializeCapsuleForIndexedDb(capsule)
    expect(persisted.photos[0].image).not.toBeInstanceOf(Blob)
    expect(persisted.photos[0].thumbnail).not.toBeInstanceOf(Blob)

    const restored = await hydrateCapsuleFromIndexedDb(
      structuredClone(persisted),
    )

    expect(restored.photos[0].image).toBeInstanceOf(Blob)
    expect(restored.photos[0].thumbnail).toBeInstanceOf(Blob)
    await expect((restored.photos[0].image as Blob).text()).resolves.toBe(
      'full-after-restart',
    )
    await expect((restored.photos[0].thumbnail as Blob).text()).resolves.toBe(
      'thumb-after-restart',
    )
    expect((restored.photos[0].image as Blob).type).toBe('image/jpeg')
    expect((restored.photos[0].thumbnail as Blob).type).toBe('image/webp')
  })

  it('migrates version-1 Blob records into fresh in-memory Blobs', async () => {
    const legacy = capsuleWithSources(
      new Blob(['legacy-full'], { type: 'image/jpeg' }),
      new Blob(['legacy-thumb'], { type: 'image/jpeg' }),
    )

    const restored = await hydrateCapsuleFromIndexedDb(legacy)

    expect(restored.photos[0].image).not.toBe(legacy.photos[0].image)
    expect(restored.photos[0].thumbnail).not.toBe(legacy.photos[0].thumbnail)
    await expect((restored.photos[0].image as Blob).text()).resolves.toBe('legacy-full')
    await expect((restored.photos[0].thumbnail as Blob).text()).resolves.toBe('legacy-thumb')
  })

  it('materializes live object URLs as Blobs before saving', async () => {
    const full = new Blob(['full'], { type: 'image/jpeg' })
    const thumb = new Blob(['thumb'], { type: 'image/jpeg' })
    const fetchMock = vi.fn(async (source: string | URL | Request) => ({
      ok: true,
      blob: async () => String(source).endsWith('thumb') ? thumb : full,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const store = createMemoryCapsuleStore()

    await store.save(capsuleWithSources('blob:full', 'blob:thumb'))

    const [saved] = await store.list()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(saved.photos[0].image).toBeInstanceOf(Blob)
    expect(saved.photos[0].thumbnail).toBeInstanceOf(Blob)
    await expect((saved.photos[0].image as Blob).text()).resolves.toBe('full')
    await expect((saved.photos[0].thumbnail as Blob).text()).resolves.toBe('thumb')
  })

  it('preserves refreshable signed URLs without fetching them during persistence', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const store = createMemoryCapsuleStore()
    const image = 'https://family.test/image?token=fresh'
    const thumbnail = 'https://family.test/thumb?token=fresh'

    await store.save(capsuleWithSources(image, thumbnail))

    const [saved] = await store.list()
    expect(saved.photos[0].image).toBe(image)
    expect(saved.photos[0].thumbnail).toBe(thumbnail)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Resilient Capsule storage', () => {
  it('keeps an authoritative primary read when fallback reconciliation fails', async () => {
    const capsule = capsuleWithSources(
      new Blob(['full'], { type: 'image/jpeg' }),
      new Blob(['thumb'], { type: 'image/jpeg' }),
    )
    const primaryStore = createMemoryCapsuleStore([capsule])
    const unavailableFallback: CapsuleStore = {
      list: vi.fn(async () => []),
      save: vi.fn(async () => {
        throw new Error('Fallback cache denied')
      }),
      remove: vi.fn(async () => {
        throw new Error('Fallback cache denied')
      }),
    }
    const store = createResilientCapsuleStore(
      primaryStore,
      unavailableFallback,
    )

    await expect(store.list()).resolves.toEqual([capsule])
  })

  it('reopens and retries the durable store after a transient save failure', async () => {
    const primaryStore = createMemoryCapsuleStore()
    const primarySave = vi.spyOn(primaryStore, 'save')
    primarySave.mockRejectedValueOnce(new Error('IndexedDB server disconnected'))
    const store = createResilientCapsuleStore(primaryStore)
    const capsule = capsuleWithSources(
      new Blob(['full'], { type: 'image/jpeg' }),
      new Blob(['thumb'], { type: 'image/jpeg' }),
    )

    await store.save(capsule)

    expect(primarySave).toHaveBeenCalledTimes(2)
    await expect(primaryStore.list()).resolves.toHaveLength(1)
  })

  it('reports a failed durable save and promotes it after storage recovers', async () => {
    const durableStore = createMemoryCapsuleStore()
    let available = false
    const primaryStore = {
      list: vi.fn(async () => {
        if (!available) throw new Error('IndexedDB server disconnected')
        return durableStore.list()
      }),
      save: vi.fn(async (capsule: FamilyCapsule) => {
        if (!available) throw new Error('IndexedDB server disconnected')
        await durableStore.save(capsule)
      }),
      remove: vi.fn(async (capsuleId: string) => {
        if (!available) throw new Error('IndexedDB server disconnected')
        await durableStore.remove(capsuleId)
      }),
    }
    const store = createResilientCapsuleStore(primaryStore)
    const capsule = capsuleWithSources(
      new Blob(['full'], { type: 'image/jpeg' }),
      new Blob(['thumb'], { type: 'image/jpeg' }),
    )

    await expect(store.save(capsule)).rejects.toThrow('IndexedDB server disconnected')
    available = true

    await expect(store.list()).resolves.toHaveLength(1)
    await expect(durableStore.list()).resolves.toHaveLength(1)
  })
})
