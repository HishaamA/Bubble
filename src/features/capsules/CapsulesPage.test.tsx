import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryCapsuleStore } from './capsuleStore'
import type { FamilyCapsule } from './types'

const capsuleImageMocks = vi.hoisted(() => ({
  processCapsuleImage: vi.fn(),
}))
const capsulePhotoDateMocks = vi.hoisted(() => ({
  getCapsulePhotoCapturedAt: vi.fn(),
}))
const capsuleServiceMocks = vi.hoisted(() => ({
  createFamilySpecialCapsule: vi.fn(),
  ensureFamilyWeeklyCapsule: vi.fn(),
  fetchFamilyCapsules: vi.fn(),
  subscribeToFamilyCapsules: vi.fn(),
  uploadFamilyCapsulePhoto: vi.fn(),
}))
const nativeRecapMocks = vi.hoisted(() => ({
  discardNativeCapsuleRecapArtifacts: vi.fn(),
  isNativeCapsuleRecapAvailable: vi.fn(),
  renderNativeCapsuleRecap: vi.fn(),
  shareNativeCapsuleRecap: vi.fn(),
  stageNativeCapsuleRecapImage: vi.fn(),
}))

vi.mock('./processCapsuleImage', () => capsuleImageMocks)
vi.mock('./capsulePhotoDate', () => capsulePhotoDateMocks)
vi.mock('./capsuleService', () => capsuleServiceMocks)
vi.mock('./recap/nativeCapsuleRecap', () => nativeRecapMocks)
vi.mock('../auth', () => ({
  useAuth: () => ({
    user: { id: 'user_simreen', displayName: 'Simreen' },
  }),
}))

import { CapsulesPage } from './CapsulesPage'

const testNow = new Date(2026, 7, 29, 12)
const currentWeekRange = 'Aug 24–Aug 30'
const previousWeekRange = 'Aug 17–Aug 23'

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
    totalPhotoCount: 1,
    familySynced: true,
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

function lockedSpecialCapsule(
  id: string,
  title: string,
  totalPhotoCount = 1,
): FamilyCapsule {
  const opensAt = new Date(2026, 8, 20, 20).toISOString()
  return {
    id,
    kind: 'special',
    title,
    createdAt: new Date(2026, 7, id === 'special-one' ? 27 : 26, 12).toISOString(),
    closesAt: opensAt,
    opensAt,
    createdByName: 'Simreen',
    photos: [{
      id: `${id}-photo`,
      capsuleId: id,
      image: new Blob([`${id}-full`], { type: 'image/jpeg' }),
      thumbnail: new Blob([`${id}-thumb`], { type: 'image/jpeg' }),
      width: 900,
      height: 1200,
      thumbnailWidth: 420,
      thumbnailHeight: 560,
      caption: `${title} breakfast`,
      capturedAt: new Date(2026, 7, 28, 8).toISOString(),
      contributorName: 'Simreen',
      ownedByCurrentUser: true,
      syncStatus: 'pending',
    }],
    totalPhotoCount,
    familySynced: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  capsuleServiceMocks.ensureFamilyWeeklyCapsule.mockResolvedValue(null)
  capsuleServiceMocks.fetchFamilyCapsules.mockResolvedValue([])
  capsuleServiceMocks.subscribeToFamilyCapsules.mockResolvedValue(() => undefined)
  capsuleServiceMocks.uploadFamilyCapsulePhoto.mockResolvedValue(null)
  capsuleServiceMocks.createFamilySpecialCapsule.mockResolvedValue(null)
  capsulePhotoDateMocks.getCapsulePhotoCapturedAt.mockResolvedValue(
    '2011-05-06T07:08:09.000Z',
  )
  capsuleImageMocks.processCapsuleImage.mockResolvedValue({
    image: new Blob(['full'], { type: 'image/jpeg' }),
    thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }),
    width: 900,
    height: 1200,
    thumbnailWidth: 420,
    thumbnailHeight: 560,
  })
  nativeRecapMocks.isNativeCapsuleRecapAvailable.mockReturnValue(false)
  nativeRecapMocks.stageNativeCapsuleRecapImage.mockResolvedValue({
    path: 'file:///tmp/CapsuleRecapStaging/photo.jpg',
  })
  nativeRecapMocks.renderNativeCapsuleRecap.mockResolvedValue({
    fileUri: 'file:///tmp/CapsuleRecaps/recap.mp4',
    width: 1080,
    height: 1920,
    frameRate: 30,
    framesPerImage: 6,
    durationMs: 200,
    imageCount: 1,
  })
  nativeRecapMocks.shareNativeCapsuleRecap.mockResolvedValue({ completed: true })
  nativeRecapMocks.discardNativeCapsuleRecapArtifacts.mockResolvedValue(undefined)
})

describe('CapsulesPage', () => {
  it('starts a weekly Capsule with ordinary-photo upload only', async () => {
    const store = createMemoryCapsuleStore()
    const { container } = render(<CapsulesPage now={testNow} store={store} />)

    expect(await screen.findByRole('heading', { name: currentWeekRange })).toBeInTheDocument()
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
    await screen.findByRole('heading', { name: currentWeekRange })

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
    expect(capsulePhotoDateMocks.getCapsulePhotoCapturedAt).toHaveBeenCalledWith(portrait)
    expect(
      capsulePhotoDateMocks.getCapsulePhotoCapturedAt.mock.invocationCallOrder[0],
    ).toBeLessThan(capsuleImageMocks.processCapsuleImage.mock.invocationCallOrder[0])

    const saved = await store.list()
    expect(saved.find(({ title }) => title === 'This week')?.photos).toHaveLength(1)
    expect(saved.find(({ title }) => title === 'This week')?.photos[0]).toMatchObject({
      width: 900,
      height: 1200,
      contributorName: 'Simreen',
      syncStatus: 'pending',
      capturedAt: '2011-05-06T07:08:09.000Z',
    })
  })

  it('sends the original capture date when a new photo is shared', async () => {
    const user = userEvent.setup()
    const capsuleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const syncedWeekly: FamilyCapsule = {
      id: capsuleId,
      kind: 'weekly',
      title: 'This week',
      weekStart: '2026-08-24',
      createdAt: new Date(2026, 7, 24).toISOString(),
      closesAt: new Date(2026, 7, 31).toISOString(),
      opensAt: new Date(2026, 7, 31).toISOString(),
      createdByName: 'Simreen',
      photos: [],
      totalPhotoCount: 0,
      familySynced: true,
    }
    capsuleServiceMocks.ensureFamilyWeeklyCapsule.mockResolvedValue({
      id: capsuleId,
      weekStart: syncedWeekly.weekStart,
    })
    capsuleServiceMocks.fetchFamilyCapsules.mockResolvedValue([syncedWeekly])
    capsuleServiceMocks.uploadFamilyCapsulePhoto.mockImplementation(
      async ({ itemId }: { itemId: string }) => itemId,
    )
    const { container } = render(
      <CapsulesPage now={testNow} store={createMemoryCapsuleStore()} />,
    )
    await screen.findByRole('heading', { name: currentWeekRange })
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    const portrait = new File(['portrait'], 'Family portrait.jpg', {
      type: 'image/jpeg',
    })

    await user.upload(input!, portrait)

    await waitFor(() => {
      expect(capsuleServiceMocks.uploadFamilyCapsulePhoto).toHaveBeenCalledWith(
        expect.objectContaining({
          capsuleId,
          capturedAt: '2011-05-06T07:08:09.000Z',
        }),
      )
    })
  })

  it('creates a named special-event Capsule that accepts family photos', async () => {
    const user = userEvent.setup()
    const store = createMemoryCapsuleStore()
    render(<CapsulesPage now={testNow} store={store} />)
    await screen.findByRole('heading', { name: currentWeekRange })

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

    const pastHeading = await screen.findByRole('heading', { name: previousWeekRange })
    const pastCard = pastHeading.closest('article')
    expect(screen.getByRole('heading', { name: 'Past weeks' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Past weekly recaps' })).toContainElement(pastCard)
    expect(screen.getByText('Swipe · play · download')).toBeInTheDocument()
    expect(screen.queryByText('Last week')).not.toBeInTheDocument()
    expect(pastCard).toHaveTextContent('Open')
    expect(pastCard).not.toHaveTextContent('Add photo')

    await user.click(screen.getByRole('button', { name: 'Play recap' }))
    expect(screen.getByRole('dialog', { name: previousWeekRange })).toBeInTheDocument()
    expect(screen.getByText('Family recap')).toBeInTheDocument()
    expect(screen.queryByText(/0\.2 seconds each/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save video' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close recap' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('does not show Past weeks before the family has an uploaded weekly photo', async () => {
    const emptyPastWeek: FamilyCapsule = {
      ...unlockedCapsule(),
      photos: [],
      totalPhotoCount: 0,
    }
    const store = createMemoryCapsuleStore([emptyPastWeek])
    render(<CapsulesPage now={testNow} store={store} />)

    await screen.findByRole('heading', { name: currentWeekRange })
    expect(screen.queryByRole('heading', { name: 'Past weeks' })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Past weekly recaps' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: previousWeekRange })).not.toBeInTheDocument()
  })

  it('keeps a locally saved family photo in Past weeks while it waits to sync', async () => {
    const pendingPastWeek = unlockedCapsule()
    pendingPastWeek.photos = pendingPastWeek.photos.map((photo) => ({
      ...photo,
      syncStatus: 'pending' as const,
    }))
    pendingPastWeek.totalPhotoCount = 1
    pendingPastWeek.familySynced = false
    const store = createMemoryCapsuleStore([pendingPastWeek])
    render(<CapsulesPage now={testNow} store={store} />)

    expect(await screen.findByRole('heading', { name: 'Past weeks' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: previousWeekRange })).toBeInTheDocument()
  })

  it('places every completed photo week in the horizontal recap slider', async () => {
    const latest = unlockedCapsule()
    const older: FamilyCapsule = {
      ...unlockedCapsule(),
      id: 'weekly-2026-08-10',
      weekStart: '2026-08-10',
      createdAt: '2026-08-10T00:00:00.000Z',
      closesAt: '2026-08-17T00:00:00.000Z',
      opensAt: '2026-08-17T00:00:00.000Z',
      photos: unlockedCapsule().photos.map((photo) => ({
        ...photo,
        id: 'photo-older',
        capsuleId: 'weekly-2026-08-10',
      })),
    }
    const store = createMemoryCapsuleStore([older, latest])
    render(<CapsulesPage now={testNow} store={store} />)

    const slider = await screen.findByRole('list', { name: 'Past weekly recaps' })
    expect(slider).toHaveAttribute('data-single', 'false')
    expect(slider.children).toHaveLength(2)
    const cards = Array.from(slider.children) as HTMLElement[]
    expect(within(cards[0]).getByRole('heading', { name: previousWeekRange })).toBeInTheDocument()
    expect(within(cards[1]).getByRole('heading', { name: 'Aug 10–Aug 16' })).toBeInTheDocument()
  })

  it('opens and saves every on-device pending photo after its Capsule unlocks', async () => {
    const user = userEvent.setup()
    const capsule = unlockedCapsule()
    const originalPhoto = capsule.photos[0]
    capsule.photos = [4, 2, 0, 3, 1].map((index) => ({
      ...originalPhoto,
      id: `local-photo-${index}`,
      image: new Blob([`full local photo ${index}`], { type: 'image/jpeg' }),
      thumbnail: new Blob([`local thumbnail ${index}`], { type: 'image/jpeg' }),
      caption: `Local photo ${index}`,
      capturedAt: `2026-08-21T18:00:0${index}.000Z`,
      syncStatus: 'pending' as const,
    }))
    capsule.totalPhotoCount = capsule.photos.length
    const store = createMemoryCapsuleStore([capsule])
    const stagedPaths = Array.from(
      { length: 5 },
      (_, index) => `file:///tmp/CapsuleRecapStaging/photo-${index}.jpg`,
    )
    nativeRecapMocks.isNativeCapsuleRecapAvailable.mockReturnValue(true)
    nativeRecapMocks.stageNativeCapsuleRecapImage.mockImplementation(async () => ({
      path: stagedPaths[nativeRecapMocks.stageNativeCapsuleRecapImage.mock.calls.length - 1],
    }))
    render(<CapsulesPage now={testNow} store={store} />)

    const card = (await screen.findByRole('heading', {
      name: previousWeekRange,
    })).closest('article')!
    const playButton = within(card).getByRole('button', { name: 'Play recap' })
    expect(playButton).toBeEnabled()
    expect(card).toHaveTextContent('5 photos saved on this phone')

    await user.click(playButton)
    const dialog = screen.getByRole('dialog', { name: previousWeekRange })
    await user.click(within(dialog).getByRole('button', { name: 'Save video' }))

    await waitFor(() => {
      expect(nativeRecapMocks.stageNativeCapsuleRecapImage).toHaveBeenCalledTimes(5)
      expect(nativeRecapMocks.stageNativeCapsuleRecapImage).toHaveBeenCalledWith(
        { dataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/) },
      )
      expect(nativeRecapMocks.renderNativeCapsuleRecap).toHaveBeenCalledWith({
        imagePaths: stagedPaths,
      })
      expect(nativeRecapMocks.shareNativeCapsuleRecap).toHaveBeenCalledWith(
        'file:///tmp/CapsuleRecaps/recap.mp4',
      )
    })
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Your recap is ready to save or share.',
    )
  })

  it('does not offer a recap for an unrecoverable legacy object URL', async () => {
    const capsule = unlockedCapsule()
    capsule.photos[0] = {
      ...capsule.photos[0],
      image: 'blob:from-an-older-app-session',
      thumbnail: 'blob:from-an-older-app-session-thumb',
      syncStatus: 'pending',
    }
    const store = createMemoryCapsuleStore([capsule])
    render(<CapsulesPage now={testNow} store={store} />)

    const card = (await screen.findByRole('heading', {
      name: previousWeekRange,
    })).closest('article')!
    expect(within(card).getByRole('button', {
      name: 'Photos unavailable on this phone',
    })).toBeDisabled()
  })

  it('obscures a locked Capsule, exposes its exact open date, and represents hidden family photos', async () => {
    const capsule = lockedSpecialCapsule('special-one', 'Lea’s wedding', 3)
    const store = createMemoryCapsuleStore([capsule])
    render(<CapsulesPage now={testNow} store={store} />)

    const heading = await screen.findByRole('heading', { name: 'Lea’s wedding' })
    const card = heading.closest('article')!
    const exactOpenDate = new Intl.DateTimeFormat('en', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(capsule.opensAt))

    expect(within(card).getByRole('img', {
      name: `Locked until ${exactOpenDate}`,
    })).toBeInTheDocument()
    expect(within(card).getByText('This Capsule unlocks')).toBeInTheDocument()
    expect(within(card).getByText(exactOpenDate)).toHaveAttribute(
      'datetime',
      capsule.opensAt,
    )
    expect(card.querySelector('.capsule-photo-strip')).toHaveAttribute('aria-hidden', 'true')
    expect(card.querySelectorAll('.capsule-photo-strip__concealed')).toHaveLength(2)
    expect(within(card).queryByRole('img', {
      name: /Lea’s wedding breakfast from Simreen/i,
    })).not.toBeInTheDocument()
    expect(within(card).getByRole('button', {
      name: 'Demo only: Preview Lea’s wedding recap',
    })).toBeInTheDocument()
  })

  it('demo-opens only the selected Capsule and includes its local pending photo', async () => {
    const user = userEvent.setup()
    const first = lockedSpecialCapsule('special-one', 'Lea’s wedding')
    const second = lockedSpecialCapsule('special-two', 'Grandpa’s 60th')
    const store = createMemoryCapsuleStore([first, second])
    render(<CapsulesPage now={testNow} store={store} />)

    const firstCard = (await screen.findByRole('heading', {
      name: first.title,
    })).closest('article')!
    const secondCard = screen.getByRole('heading', {
      name: second.title,
    }).closest('article')!
    await user.click(within(firstCard).getByRole('button', {
      name: `Demo only: Preview ${first.title} recap`,
    }))

    const dialog = screen.getByRole('dialog', { name: first.title })
    expect(within(dialog).getByText('Demo preview')).toBeInTheDocument()
    expect(within(dialog).queryByText(/0\.2 seconds each/i)).not.toBeInTheDocument()
    expect(within(dialog).getByText('Simreen')).toBeInTheDocument()
    expect(firstCard).toHaveAttribute('data-demo-unlocked', 'true')
    expect(secondCard).toHaveAttribute('data-demo-unlocked', 'false')
    expect(within(secondCard).getByRole('img', { name: /Locked until/ })).toBeInTheDocument()
    expect((await store.list()).find(({ id }) => id === first.id)?.opensAt).toBe(first.opensAt)

    await user.click(within(dialog).getByRole('button', { name: 'Close recap' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(firstCard).toHaveAttribute('data-demo-unlocked', 'false')
    expect(within(firstCard).getByRole('img', { name: /Locked until/ })).toBeInTheDocument()
  })

  it('uses an intentional placeholder for an unrecoverable legacy object URL', async () => {
    const staleCapsule = unlockedCapsule()
    staleCapsule.photos[0] = {
      ...staleCapsule.photos[0],
      image: 'blob:from-an-older-app-session',
      thumbnail: 'blob:from-an-older-app-session-thumb',
    }
    const store = createMemoryCapsuleStore([staleCapsule])
    render(<CapsulesPage now={testNow} store={store} />)

    const card = (await screen.findByRole('heading', {
      name: previousWeekRange,
    })).closest('article')!
    expect(within(card).getByRole('img', {
      name: /Preview unavailable until KinSphere reconnects/i,
    })).toBeInTheDocument()
    expect(card.querySelector('img')).toBeNull()
  })

  it('keeps an expired signed thumbnail behind a placeholder instead of a broken icon', async () => {
    const store = createMemoryCapsuleStore([unlockedCapsule()])
    render(<CapsulesPage now={testNow} store={store} />)

    const card = (await screen.findByRole('heading', {
      name: previousWeekRange,
    })).closest('article')!
    const image = card.querySelector('img')
    expect(image).not.toBeNull()
    expect(within(card).getByRole('img', {
      name: /Loading preview/i,
    })).toBeInTheDocument()

    fireEvent.error(image!)

    expect(card.querySelector('img')).toBeNull()
    expect(within(card).getByRole('img', {
      name: /Preview unavailable until KinSphere reconnects/i,
    })).toBeInTheDocument()
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
    expect(saved[0].photos[0].image).toBeInstanceOf(Blob)
    expect(saved[0].photos[0].thumbnail).toBeInstanceOf(Blob)
  })

  it('keeps a restart-restored synced Blob when the server returns only its count', async () => {
    const capsuleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const photoId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const restoredPhoto = {
      id: photoId,
      capsuleId,
      image: new Blob(['restored-full'], { type: 'image/jpeg' }),
      thumbnail: new Blob(['restored-thumb'], { type: 'image/jpeg' }),
      width: 900,
      height: 1200,
      thumbnailWidth: 420,
      thumbnailHeight: 560,
      caption: 'Saturday pancakes',
      capturedAt: '2026-08-28T08:00:00.000Z',
      contributorName: 'Simreen',
      ownedByCurrentUser: true,
      syncStatus: 'synced' as const,
    }
    const restoredCapsule: FamilyCapsule = {
      id: capsuleId,
      kind: 'weekly',
      title: 'This week',
      weekStart: '2026-08-24',
      createdAt: '2026-08-24T00:00:00.000Z',
      closesAt: '2026-08-31T00:00:00.000Z',
      opensAt: '2026-08-31T00:00:00.000Z',
      createdByName: 'Simreen',
      photos: [restoredPhoto],
      totalPhotoCount: 1,
      familySynced: true,
    }
    const metadataOnlyServerCapsule: FamilyCapsule = {
      ...restoredCapsule,
      photos: [],
      totalPhotoCount: 1,
    }
    const store = createMemoryCapsuleStore([restoredCapsule])
    capsuleServiceMocks.ensureFamilyWeeklyCapsule.mockResolvedValue({
      id: capsuleId,
      weekStart: '2026-08-24',
    })
    capsuleServiceMocks.fetchFamilyCapsules.mockResolvedValue([
      metadataOnlyServerCapsule,
    ])

    render(<CapsulesPage now={testNow} store={store} />)

    expect(await screen.findByText('1 photo')).toBeInTheDocument()
    await waitFor(async () => {
      const [saved] = await store.list()
      expect(saved.photos).toHaveLength(1)
      expect(saved.photos[0]).toMatchObject({
        id: photoId,
        syncStatus: 'synced',
      })
      expect(saved.photos[0].image).toBeInstanceOf(Blob)
      expect(saved.photos[0].thumbnail).toBeInstanceOf(Blob)
    })
    expect(capsuleServiceMocks.uploadFamilyCapsulePhoto).not.toHaveBeenCalled()
  })
})
