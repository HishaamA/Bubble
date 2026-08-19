import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FamilyCapsule } from '../features/capsules/types'
import type { JournalPhoto } from '../features/journal/journalPhotoTypes'
import type { PanoramaMoment } from '../features/memories/shared'
import { SharedMomentsContext } from '../features/memories/shared/context'
import { FamilyMomentSyncContext } from '../features/memories/shared/useFamilyMomentSync'
import { JournalRoute, MemoriesRoute } from './MemoryExperienceRoutes'

const routeMocks = vi.hoisted(() => ({
  journalPage: vi.fn(),
  memoryConstellation: vi.fn(),
}))

vi.mock('../features/journal', () => ({
  JournalPage: (props: unknown) => {
    routeMocks.journalPage(props)
    return <div data-testid="journal-page">Journal</div>
  },
}))

vi.mock('../features/memories/MemoryConstellation', () => ({
  MemoryConstellation: (props: unknown) => {
    routeMocks.memoryConstellation(props)
    return <div data-testid="memory-constellation">Memories</div>
  },
}))

vi.mock('../features/auth', () => ({
  useAuth: () => ({ user: { id: 'journal-route-test-user' } }),
}))

const uploadedMoment: PanoramaMoment = {
  id: 'route-balcony',
  blob: new Blob(['panorama'], { type: 'image/jpeg' }),
  objectUrl: 'blob:route-balcony',
  label: 'Balcony laughter',
  caption: 'Everyone made it.',
  createdAt: new Date(2026, 7, 26, 10).toISOString(),
  width: 4000,
  height: 2000,
  source: 'manual',
  uploaderDisplayName: 'Maya',
}

const openedCapsule: FamilyCapsule = {
  id: 'route-capsule',
  kind: 'weekly',
  title: 'Our family week',
  createdAt: new Date(2026, 7, 17, 9).toISOString(),
  closesAt: new Date(2026, 7, 24, 9).toISOString(),
  opensAt: new Date(2026, 7, 25, 9).toISOString(),
  weekStart: '2026-08-17',
  createdByName: 'Maya',
  photos: [],
}

const directPhoto: JournalPhoto = {
  id: '11111111-1111-4111-8111-111111111111',
  image: '/direct.jpg',
  thumbnail: '/direct-thumb.jpg',
  width: 1200,
  height: 900,
  thumbnailWidth: 400,
  thumbnailHeight: 300,
  caption: 'Direct upload',
  capturedAt: '2026-08-20T12:00:00.000Z',
  contributorName: 'Maya',
  ownedByCurrentUser: true,
  syncStatus: 'pending',
}

describe('JournalRoute', () => {
  beforeEach(() => {
    routeMocks.journalPage.mockClear()
    routeMocks.memoryConstellation.mockClear()
  })

  it('passes the real archive, clock, and cache namespace to Journal without shared moments', () => {
    const now = new Date(2026, 7, 26, 12)
    const capsules = [openedCapsule]

    render(
      <MemoryRouter>
        <JournalRoute
          now={now}
          capsules={capsules}
          journalPhotos={[directPhoto]}
          capsuleCacheNamespace="family:ahmed"
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('journal-page')).toBeInTheDocument()
    const journalProps = routeMocks.journalPage.mock.lastCall?.[0] as {
      now: Date
      capsuleNow: Date
      capsules: FamilyCapsule[]
      capsuleCacheNamespace: string
      journalPhotos: JournalPhoto[]
      onUploadJournalPhotos: unknown
    }
    expect(journalProps.now).toBe(now)
    expect(journalProps.capsuleNow).toBe(now)
    expect(journalProps).not.toHaveProperty('sharedMoments')
    expect(journalProps.capsules).toBe(capsules)
    expect(journalProps.journalPhotos).toEqual([directPhoto])
    expect(journalProps.onUploadJournalPhotos).toEqual(expect.any(Function))
    expect(journalProps.capsuleCacheNamespace).toBe('family:ahmed')
  })

  it('keeps shared 360 moments connected to Memories', () => {
    const deleteMoment = vi.fn(async () => undefined)

    render(
      <SharedMomentsContext.Provider
        value={{
          loading: false,
          error: null,
          moments: [uploadedMoment],
          saveMoment: vi.fn(),
          removeMoments: vi.fn(),
          refresh: vi.fn(),
        }}
      >
        <FamilyMomentSyncContext.Provider
          value={{
            status: 'connected',
            dailyWindow: null,
            error: null,
            shareMoment: vi.fn(),
            updateMomentAnnotations: vi.fn(),
            deleteMoment,
            refreshFamilyMoments: vi.fn(),
          }}
        >
          <MemoriesRoute />
        </FamilyMomentSyncContext.Provider>
      </SharedMomentsContext.Provider>,
    )

    expect(screen.getByTestId('memory-constellation')).toBeInTheDocument()
    expect(routeMocks.memoryConstellation).toHaveBeenLastCalledWith({
      sharedMoments: [uploadedMoment],
      onDelete360: deleteMoment,
    })
  })
})
