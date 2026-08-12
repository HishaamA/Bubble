import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryCapsuleStore } from './capsuleStore'
import type { FamilyCapsule } from './types'

const capsuleImageMocks = vi.hoisted(() => ({
  processCapsuleImage: vi.fn(),
}))
const capsuleServiceMocks = vi.hoisted(() => ({
  createFamilySpecialCapsule: vi.fn(),
  ensureFamilyWeeklyCapsule: vi.fn(),
  fetchFamilyCapsules: vi.fn(),
  subscribeToFamilyCapsules: vi.fn(),
  uploadFamilyCapsulePhoto: vi.fn(),
}))

vi.mock('./processCapsuleImage', () => capsuleImageMocks)
vi.mock('./capsuleService', () => capsuleServiceMocks)
vi.mock('../auth', () => ({
  useAuth: () => ({
    user: { id: 'user_simreen', displayName: 'Simreen' },
  }),
}))

import { CapsulesPage } from './CapsulesPage'

const testNow = new Date(2026, 7, 29, 12)

function unlockedCapsule(): FamilyCapsule {
  return {
    id: 'weekly-2026-08-17',
    kind: 'weekly',
    title: 'Last week',
    weekStart: '2026-08-17',
    createdAt: '2026-08-17T00:00:00.000Z',
    closesAt: '2026-08-24T00:00:00.000Z',
    opensAt: '2026-08-24T00:00:00.000Z',
    createdByName: 'Simreen',
    photos: [
      {
        id: 'photo-one',
        capsuleId: 'weekly-2026-08-17',
        image: '/photo-one.jpg',
        thumbnail: '/photo-one-thumb.jpg',
        width: 1200,
        height: 1600,
        caption: 'Friday flowers',
        capturedAt: '2026-08-21T18:00:00.000Z',
        contributorName: 'Simreen',
        ownedByCurrentUser: true,
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  capsuleServiceMocks.ensureFamilyWeeklyCapsule.mockResolvedValue(null)
  capsuleServiceMocks.fetchFamilyCapsules.mockResolvedValue([])
  capsuleServiceMocks.subscribeToFamilyCapsules.mockResolvedValue(() => undefined)
  capsuleServiceMocks.uploadFamilyCapsulePhoto.mockResolvedValue(null)
  capsuleServiceMocks.createFamilySpecialCapsule.mockResolvedValue(null)
  capsuleImageMocks.processCapsuleImage.mockResolvedValue({
    image: new Blob(['full'], { type: 'image/jpeg' }),
    thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }),
    width: 900,
    height: 1200,
    thumbnailWidth: 420,
    thumbnailHeight: 560,
  })
})

describe('CapsulesPage', () => {
  it('starts a weekly Capsule with ordinary-photo upload only', async () => {
    const store = createMemoryCapsuleStore()
    const { container } = render(<CapsulesPage now={testNow} store={store} />)

    expect(await screen.findByRole('heading', { name: 'This week' })).toBeInTheDocument()
    expect(screen.getByText('Photos only · not 360°')).toBeInTheDocument()

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    expect(input).toHaveAttribute('accept', 'image/*')
    expect(input).not.toHaveAttribute('capture')
    expect(screen.queryByText(/panorama/i)).not.toBeInTheDocument()
  })

  it('adds and persists an uploaded regular photo without a 2:1 check', async () => {
    const user = userEvent.setup()
    const store = createMemoryCapsuleStore()
    const { container } = render(<CapsulesPage now={testNow} store={store} />)
    await screen.findByRole('heading', { name: 'This week' })

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    const portrait = new File(['portrait'], 'Saturday pancakes.jpg', {
      type: 'image/jpeg',
    })
    await user.upload(input!, portrait)

    expect(await screen.findByText('1 photo')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Saturday pancakes.jpg is saved on this device and waiting to share with your family.',
    )
    expect(capsuleImageMocks.processCapsuleImage).toHaveBeenCalledWith(portrait)

    const saved = await store.list()
    expect(saved.find(({ title }) => title === 'This week')?.photos).toHaveLength(1)
    expect(saved.find(({ title }) => title === 'This week')?.photos[0]).toMatchObject({
      width: 900,
      height: 1200,
      contributorName: 'Simreen',
      syncStatus: 'pending',
    })
  })

  it('creates a named special-event Capsule that accepts family photos', async () => {
    const user = userEvent.setup()
    const store = createMemoryCapsuleStore()
    render(<CapsulesPage now={testNow} store={store} />)
    await screen.findByRole('heading', { name: 'This week' })

    await user.click(screen.getByRole('button', { name: 'Create a special Capsule' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Grandpa’s 60th')
    const openDate = screen.getByLabelText('Open after')
    await user.clear(openDate)
    await user.type(openDate, '2026-09-20')
    await user.click(screen.getByRole('button', { name: 'Create Capsule' }))

    const heading = screen.getByRole('heading', { name: 'Grandpa’s 60th' })
    expect(heading).toBeInTheDocument()
    expect(heading.closest('article')).toHaveTextContent('Add photo')
    expect(await store.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'special',
          title: 'Grandpa’s 60th',
        }),
      ]),
    )
  })

  it('keeps a finished week locked to contributions and opens its recap player', async () => {
    const user = userEvent.setup()
    const store = createMemoryCapsuleStore([unlockedCapsule()])
    render(<CapsulesPage now={testNow} store={store} />)

    const pastHeading = await screen.findByRole('heading', { name: 'Last week' })
    const pastCard = pastHeading.closest('article')
    expect(pastCard).toHaveTextContent('Open')
    expect(pastCard).not.toHaveTextContent('Add photo')

    await user.click(screen.getByRole('button', { name: 'Play recap' }))
    expect(screen.getByRole('dialog', { name: 'Last week' })).toBeInTheDocument()
    expect(screen.getByText('Family recap · 0.2 seconds each')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save video' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close recap' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('uses the server-authoritative week and retries a durable pending photo', async () => {
    const serverCapsuleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const pendingPhotoId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const localCapsuleId = 'weekly-2026-08-31'
    const pendingPhoto = {
      id: pendingPhotoId,
      capsuleId: localCapsuleId,
      image: new Blob(['full'], { type: 'image/jpeg' }),
      thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }),
      width: 900,
      height: 1200,
      thumbnailWidth: 420,
      thumbnailHeight: 560,
      caption: 'Sunday flowers',
      capturedAt: '2026-08-30T18:00:00.000Z',
      contributorName: 'Simreen',
      ownedByCurrentUser: true,
      syncStatus: 'pending' as const,
    }
    const localCapsule: FamilyCapsule = {
      id: localCapsuleId,
      kind: 'weekly',
      title: 'This week',
      weekStart: '2026-08-31',
      createdAt: '2026-08-31T00:00:00.000Z',
      closesAt: '2026-09-07T00:00:00.000Z',
      opensAt: '2026-09-07T00:00:00.000Z',
      createdByName: 'Simreen',
      photos: [pendingPhoto],
      totalPhotoCount: 1,
      familySynced: false,
    }
    const remoteCapsule: FamilyCapsule = {
      ...localCapsule,
      id: serverCapsuleId,
      photos: [],
      totalPhotoCount: 0,
      familySynced: true,
    }
    const syncedRemoteCapsule: FamilyCapsule = {
      ...remoteCapsule,
      photos: [{
        ...pendingPhoto,
        capsuleId: serverCapsuleId,
        image: 'https://family.test/photo',
        thumbnail: 'https://family.test/thumb',
        syncStatus: 'synced',
      }],
      totalPhotoCount: 1,
    }
    const store = createMemoryCapsuleStore([localCapsule])
    capsuleServiceMocks.ensureFamilyWeeklyCapsule.mockResolvedValue({
      id: serverCapsuleId,
      weekStart: '2026-08-31',
    })
    capsuleServiceMocks.fetchFamilyCapsules
      .mockResolvedValueOnce([remoteCapsule])
      .mockResolvedValue([syncedRemoteCapsule])
    capsuleServiceMocks.uploadFamilyCapsulePhoto.mockResolvedValue(pendingPhotoId)

    render(<CapsulesPage now={testNow} store={store} />)

    expect(await screen.findByText('1 photo')).toBeInTheDocument()
    await waitFor(() => {
      expect(capsuleServiceMocks.uploadFamilyCapsulePhoto).toHaveBeenCalledWith(
        expect.objectContaining({
          capsuleId: serverCapsuleId,
          itemId: pendingPhotoId,
        }),
      )
    })
    const saved = await store.list()
    expect(saved).toEqual([
      expect.objectContaining({
        id: serverCapsuleId,
        familySynced: true,
        photos: [expect.objectContaining({ id: pendingPhotoId, syncStatus: 'synced' })],
      }),
    ])
  })
})
