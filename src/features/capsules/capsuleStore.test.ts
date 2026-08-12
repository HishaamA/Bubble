import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  capsuleDatabaseNameForSubject,
  createMemoryCapsuleStore,
} from './capsuleStore'
import type { FamilyCapsule } from './types'

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
