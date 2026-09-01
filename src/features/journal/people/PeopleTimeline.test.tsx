import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnlockedCapsulePhoto } from '../capsuleJournalArchive'
import type { JournalPhoto } from '../journalPhotoTypes'
import { scanReferencePortrait, scanTimelineFaces } from './faceRecognition'
import { PeopleTimeline } from './PeopleTimeline'
import { emptyPeopleTimelineState } from './peopleTimelineStore'
import type {
  FaceProfile,
  PeopleTimelineState,
  StoredFaceDetection,
  StoredPhotoFaceScan,
} from './types'

const storedStates = vi.hoisted(() => new Map<string, unknown>())

vi.mock('./faceRecognition', () => ({
  scanReferencePortrait: vi.fn(),
  scanTimelineFaces: vi.fn(),
}))

vi.mock('./peopleTimelineStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./peopleTimelineStore')>()
  return {
    ...actual,
    loadPeopleTimelineState: vi.fn(async (namespace: string) =>
      storedStates.get(namespace) ?? actual.emptyPeopleTimelineState(),
    ),
    savePeopleTimelineState: vi.fn(async (
      namespace: string,
      state: PeopleTimelineState,
    ) => {
      storedStates.set(namespace, state)
      return true
    }),
  }
})

function capsulePhoto(
  id: string,
  capturedAt: string,
  caption: string,
): UnlockedCapsulePhoto {
  return {
    id,
    capsuleId: 'family-week',
    image: `/photos/${id}.jpg`,
    thumbnail: `/photos/${id}-thumb.jpg`,
    width: 1200,
    height: 900,
    caption,
    capturedAt,
    contributorName: 'Maya',
    ownedByCurrentUser: false,
    capsuleTitle: 'Our week',
    capsuleOpensAt: '2026-01-10T00:00:00.000Z',
  }
}

function journalPhoto(id: string): JournalPhoto {
  return {
    id,
    image: `/photos/${id}.jpg`,
    thumbnail: `/photos/${id}-thumb.jpg`,
    width: 1200,
    height: 900,
    thumbnailWidth: 400,
    thumbnailHeight: 300,
    caption: 'Direct family upload',
    capturedAt: '2024-02-03T12:00:00.000Z',
    contributorName: 'Maya',
    ownedByCurrentUser: true,
    syncStatus: 'pending',
  }
}

function stateWith(
  changes: Partial<PeopleTimelineState>,
): PeopleTimelineState {
  return { ...emptyPeopleTimelineState(), ...changes }
}

const mayaEmbedding = Array<number>(1_024).fill(0)
const leenaEmbedding = Array<number>(1_024).fill(1)

function faceProfile(
  ...embeddings: readonly number[][]
): FaceProfile {
  return {
    references: embeddings.map((embedding, index) => ({
      id: `reference-${index + 1}`,
      embedding: [...embedding],
      source: 'enrollment',
      createdAt: '2026-01-01T00:00:00.000Z',
      quality: 0.9,
    })),
  }
}

function detectedFace(
  id: string,
  embedding: readonly number[],
  quality = 0.9,
): StoredFaceDetection {
  return {
    id,
    embedding: [...embedding],
    box: [0.1, 0.1, 0.35, 0.45],
    detectorScore: 0.95,
    descriptorScore: 0.94,
    quality,
  }
}

function faceScan(...faces: StoredFaceDetection[]): StoredPhotoFaceScan {
  return {
    scannedAt: '2026-01-02T00:00:00.000Z',
    faces,
  }
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function RouteState() {
  const location = useLocation()
  const state = location.state as {
    returnTo?: string
    journalContext?: {
      section?: string
      personId?: string
      focusMemoryId?: string
    }
  } | null
  return (
    <output aria-label="Route state">
      {location.pathname}|{state?.returnTo}|{state?.journalContext?.section}|
      {state?.journalContext?.personId}|{state?.journalContext?.focusMemoryId}
    </output>
  )
}

function renderTimeline(
  photos: UnlockedCapsulePhoto[],
  namespace = `people-test-${Math.random()}`,
  restore: { initialPersonId?: string; focusMemoryId?: string } = {},
) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={(
          <PeopleTimeline
            photos={photos}
            cacheNamespace={namespace}
            initialPersonId={restore.initialPersonId}
            focusMemoryId={restore.focusMemoryId}
          />
        )} />
        <Route path="*" element={<RouteState />} />
      </Routes>
    </MemoryRouter>,
  )
}

function timelineChip(name: string) {
  return within(screen.getByRole('group', {
    name: 'Choose a person timeline',
  })).getByRole('button', { name })
}

describe('PeopleTimeline', () => {
  beforeEach(() => {
    storedStates.clear()
    vi.mocked(scanReferencePortrait).mockReset()
    vi.mocked(scanReferencePortrait).mockResolvedValue({
      embedding: mayaEmbedding,
      quality: 0.9,
    })
    vi.mocked(scanTimelineFaces).mockReset()
    vi.mocked(scanTimelineFaces).mockImplementation(async (photos, checkpoint) => {
      const faceScans: Record<string, StoredPhotoFaceScan> = {}
      for (let index = 0; index < photos.length; index += 1) {
        const photo = photos[index]
        if (!photo) continue
        const scan = faceScan()
        faceScans[photo.key] = scan
        await checkpoint?.({
          photoKey: photo.key,
          faceScan: scan,
          failed: false,
          completed: index + 1,
          total: photos.length,
        })
      }
      return {
        faceScans,
        failedPhotoCount: 0,
        completedPhotoCount: photos.length,
      }
    })
  })

  it('presents people onboarding and opens the existing add-person form', async () => {
    const user = userEvent.setup()
    renderTimeline([])

    expect(await screen.findByRole('heading', {
      name: 'Create your people',
    })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add person' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Empty family slot 1' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Empty family slot 2' })).toBeDisabled()
    expect(within(screen.getByLabelText('Family face setup')).getAllByRole('button')).toHaveLength(3)

    expect(screen.queryByRole('button', {
      name: 'Add first person',
    })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add person' }))

    expect(screen.getByRole('form', { name: 'Add a person' })).toBeInTheDocument()
    expect(scanReferencePortrait).not.toHaveBeenCalled()
    expect(scanTimelineFaces).not.toHaveBeenCalled()
  })

  it('returns focus to the people-rail Add person control after cancelling', async () => {
    const user = userEvent.setup()
    renderTimeline([])
    await screen.findByRole('heading', { name: 'Create your people' })
    const opener = screen.getByRole('button', { name: 'Add person' })

    await user.click(opener)
    const form = screen.getByRole('form', { name: 'Add a person' })
    await user.click(within(form).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('form', { name: 'Add a person' }))
      .not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('returns focus to the empty scrapbook card after cancelling', async () => {
    const user = userEvent.setup()
    renderTimeline([])
    await screen.findByRole('heading', { name: 'Create your people' })
    const opener = screen.getByRole('button', {
      name: /Your first scrapbook starts here/i,
    })

    await user.click(opener)
    const form = screen.getByRole('form', { name: 'Add a person' })
    await user.click(within(form).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('form', { name: 'Add a person' }))
      .not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('keeps every family member in the compact people rail and adds more from its trailing circle', async () => {
    const namespace = 'people-notes-rail'
    storedStates.set(namespace, stateWith({
      people: [
        { id: 'maya', name: 'Maya', createdAt: '2026-01-01' },
        { id: 'leena', name: 'Leena', createdAt: '2026-01-01' },
        { id: 'omar', name: 'Omar', createdAt: '2026-01-01' },
        { id: 'sara', name: 'Sara', createdAt: '2026-01-01' },
      ],
      faceProfiles: {
        maya: faceProfile(mayaEmbedding),
        leena: faceProfile(leenaEmbedding),
        omar: faceProfile(mayaEmbedding),
        sara: faceProfile(leenaEmbedding),
      },
    }))
    const user = userEvent.setup()
    renderTimeline([], namespace)

    const peopleRail = await screen.findByRole('group', { name: 'Family face setup' })
    expect(within(peopleRail).getAllByRole('button')).toHaveLength(5)
    expect(within(peopleRail).getByRole('button', { name: 'Maya' })).toBeInTheDocument()
    expect(within(peopleRail).getByRole('button', { name: 'Sara' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Create your people' })).not.toBeInTheDocument()

    await user.click(within(peopleRail).getByRole('button', { name: 'Add person' }))
    expect(screen.getByRole('form', { name: 'Add a person' })).toBeInTheDocument()
  })

  it('keeps Family separate and exposes ordinary uploads only through Review', async () => {
    const user = userEvent.setup()
    renderTimeline([
      capsulePhoto('new', '2026-03-15T12:00:00.000Z', 'Graduation day'),
      capsulePhoto('old', '2012-06-01T12:00:00.000Z', 'First school day'),
    ])

    expect(await screen.findByRole('heading', {
      name: 'Create your people',
    })).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.queryByText('360°')).not.toBeInTheDocument()

    await user.click(timelineChip('All photos'))
    const slider = await screen.findByRole('slider', {
      name: 'Timeline position for All photos',
    })
    expect(slider).toHaveAttribute('aria-valuetext', '1 of 2, June 1, 2012')
    const landscapePhoto = screen.getByRole('img', { name: 'First school day' })
    expect(landscapePhoto).toHaveAttribute(
      'src',
      '/photos/old.jpg',
    )
    expect(landscapePhoto).toHaveAttribute('width', '1200')
    expect(landscapePhoto).toHaveAttribute('height', '900')
    expect(screen.getByRole('figure', {
      name: 'First school day, shared by Maya',
    })).toHaveClass('people-timeline__album-photo')

    fireEvent.change(slider, { target: { value: '1' } })
    expect(await screen.findByRole('img', { name: 'Graduation day' })).toBeInTheDocument()
    expect(screen.queryByRole('link', {
      name: 'Open Graduation day, shared by Maya',
    })).not.toBeInTheDocument()
  })

  it('requires a clear portrait when adding a person and never adds it to uploads', async () => {
    const user = userEvent.setup()
    renderTimeline([])
    await screen.findByRole('heading', { name: 'Create your people' })
    const addPersonButton = screen.getByRole('button', {
      name: 'Add person',
    })

    await user.click(addPersonButton)
    const form = screen.getByRole('form', { name: 'Add a person' })
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Maya')
    await user.click(within(form).getByRole('button', { name: 'Add person' }))
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Choose at least one clear face photo',
    )

    const portrait = new File(['portrait'], 'maya.jpg', { type: 'image/jpeg' })
    await user.upload(within(form).getByLabelText(/^Face photo/), portrait)
    await user.click(within(form).getByRole('button', { name: 'Add person' }))

    expect(await screen.findByRole('button', { name: 'Maya' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(scanReferencePortrait).toHaveBeenCalledWith(portrait)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText(/reference photos are scanned once and never stored/i)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Maya is ready. Add family photos',
    )
    await waitFor(() => expect(addPersonButton).toHaveFocus())
  })

  it('starts one enrollment scan when add-person is submitted twice in one turn', async () => {
    const user = userEvent.setup()
    const pendingScan = deferred<Awaited<ReturnType<typeof scanReferencePortrait>>>()
    vi.mocked(scanReferencePortrait).mockReturnValue(pendingScan.promise)
    renderTimeline([])
    await screen.findByRole('heading', { name: 'Create your people' })

    await user.click(screen.getByRole('button', { name: 'Add person' }))
    const form = screen.getByRole('form', { name: 'Add a person' })
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Maya')
    await user.upload(
      within(form).getByLabelText(/^Face photo/),
      new File(['portrait'], 'maya.jpg', { type: 'image/jpeg' }),
    )

    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(scanReferencePortrait).toHaveBeenCalledTimes(1)
    await act(async () => {
      pendingScan.resolve({ embedding: mayaEmbedding, quality: 0.9 })
      await pendingScan.promise
    })
    expect(await screen.findByRole('button', { name: 'Maya' })).toBeInTheDocument()
  })

  it('enrolls several face views together and keeps every successful reference', async () => {
    const namespace = 'people-multi-reference'
    const alternateEmbedding = mayaEmbedding.map((value, index) =>
      value + (index % 2 === 0 ? 0.08 : 0.04),
    )
    vi.mocked(scanReferencePortrait)
      .mockResolvedValueOnce({ embedding: mayaEmbedding, quality: 0.92 })
      .mockResolvedValueOnce({ embedding: alternateEmbedding, quality: 0.84 })
    const user = userEvent.setup()
    renderTimeline([], namespace)
    await screen.findByRole('heading', { name: 'Create your people' })
    const addPersonButton = screen.getByRole('button', {
      name: 'Add person',
    })

    await user.click(addPersonButton)
    const form = screen.getByRole('form', { name: 'Add a person' })
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Maya')
    const front = new File(['front'], 'maya-front.jpg', { type: 'image/jpeg' })
    const side = new File(['side'], 'maya-side.jpg', { type: 'image/jpeg' })
    const facePicker = within(form).getByLabelText(/^Face photos/)
    expect(facePicker).toHaveAttribute('multiple')
    await user.upload(facePicker, [front, side])
    await user.click(within(form).getByRole('button', { name: 'Add person' }))

    expect(await screen.findByRole('button', { name: 'Maya' })).toBeInTheDocument()
    expect(scanReferencePortrait).toHaveBeenNthCalledWith(1, front)
    expect(scanReferencePortrait).toHaveBeenNthCalledWith(2, side)
    await waitFor(() => {
      const savedState = storedStates.get(namespace) as PeopleTimelineState
      const mayaId = savedState.people.find(({ name }) => name === 'Maya')?.id
      expect(mayaId).toBeTruthy()
      expect(savedState.faceProfiles[mayaId ?? '']?.references).toEqual([
        expect.objectContaining({ embedding: mayaEmbedding, quality: 0.92 }),
        expect.objectContaining({ embedding: alternateEmbedding, quality: 0.84 }),
      ])
    })

    await user.click(screen.getByRole('button', { name: 'Rename or remove Maya' }))
    expect(screen.getByText('2 face views ready')).toBeInTheDocument()
  })

  it('keeps the person manager compact while clearly reporting chosen face photos', async () => {
    const namespace = 'people-manage-picker'
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
    }))
    const user = userEvent.setup()
    renderTimeline([], namespace, { initialPersonId: 'maya' })

    await user.click(await screen.findByRole('button', {
      name: 'Rename or remove Maya',
    }))
    const manager = screen.getByRole('region', { name: 'Manage Maya' })
    const picker = within(manager).getByLabelText('Face photo for Maya')
    const addViews = within(manager).getByRole('button', { name: 'Add face views' })

    expect(within(manager).getByText('Person details')).toBeInTheDocument()
    expect(within(manager).getByText('Up to 5 photos')).toBeInTheDocument()
    expect(addViews).toBeDisabled()

    await user.upload(
      picker,
      new File(['side'], 'maya-side.jpg', { type: 'image/jpeg' }),
    )

    expect(within(manager).getByText('1 photo selected')).toBeInTheDocument()
    expect(addViews).toBeEnabled()
    await user.click(within(manager).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('region', { name: 'Manage Maya' }))
      .not.toBeInTheDocument()
  })

  it('starts one reference scan when add-face-views is submitted twice in one turn', async () => {
    const namespace = 'people-reference-submit-latch'
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
    }))
    const pendingScan = deferred<Awaited<ReturnType<typeof scanReferencePortrait>>>()
    vi.mocked(scanReferencePortrait).mockReturnValue(pendingScan.promise)
    const user = userEvent.setup()
    renderTimeline([], namespace, { initialPersonId: 'maya' })

    await user.click(await screen.findByRole('button', {
      name: 'Rename or remove Maya',
    }))
    const form = screen.getByRole('form', { name: 'Add face photos for Maya' })
    await user.upload(
      within(form).getByLabelText('Face photo for Maya'),
      new File(['side'], 'maya-side.jpg', { type: 'image/jpeg' }),
    )

    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(scanReferencePortrait).toHaveBeenCalledTimes(1)
    await act(async () => {
      pendingScan.resolve({ embedding: leenaEmbedding, quality: 0.86 })
      await pendingScan.promise
    })
    await waitFor(() => expect(
      (storedStates.get(namespace) as PeopleTimelineState)
        .faceProfiles.maya?.references,
    ).toHaveLength(2))
  })

  it('announces when a person still needs a face photo', async () => {
    const namespace = 'people-missing-face'
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
    }))
    renderTimeline([], namespace)

    const chip = await screen.findByRole('button', {
      name: 'Maya, face photo needed',
    })
    expect(chip).toHaveTextContent('Maya')
    expect(chip).toHaveAttribute('data-needs-face', 'true')
  })

  it('shows only uncertain matches in Review and supports Yes, No, and Not sure', async () => {
    const namespace = 'people-face-review'
    const reviewBase = Array<number>(1_024).fill(1)
    const mediumA = reviewBase.map((value) => value + 0.3)
    const mediumB = reviewBase.map((value, index) =>
      value + (index % 2 === 0 ? -0.3 : 0.3),
    )
    const mediumC = reviewBase.map((value, index) =>
      value + (index % 3 === 0 ? -0.3 : 0.3),
    )
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(reviewBase) },
      faceScans: {
        'photo:first': faceScan(detectedFace('face-1', mediumA)),
        'photo:second': faceScan(detectedFace('face-1', mediumB)),
        'photo:third': faceScan(detectedFace('face-1', mediumC)),
      },
    }))
    const user = userEvent.setup()
    renderTimeline([
      capsulePhoto('first', '2020-01-01T12:00:00.000Z', 'First uncertain face'),
      capsulePhoto('second', '2021-01-01T12:00:00.000Z', 'Second uncertain face'),
      capsulePhoto('third', '2022-01-01T12:00:00.000Z', 'Third uncertain face'),
    ], namespace)

    const facesToName = await screen.findByRole('region', {
      name: 'Faces to name',
    })
    expect(within(facesToName).getByRole('button', {
      name: 'Review all',
    })).toBeInTheDocument()
    expect(within(facesToName).getAllByRole('button', {
      name: 'Review face suggested as Maya',
    })).toHaveLength(3)

    const reviewChip = await screen.findByRole('button', { name: 'Review 3' })
    expect(reviewChip).toHaveAttribute('aria-pressed', 'false')
    await user.click(reviewChip)
    expect(await screen.findByText('Is the outlined face Maya?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Not sure' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Yes' }))
    expect(await screen.findByRole('img', { name: 'Second uncertain face' })).toBeInTheDocument()
    await waitFor(() => expect(
      (storedStates.get(namespace) as PeopleTimelineState).assignments,
    ).toContainEqual(expect.objectContaining({
      photoKey: 'photo:first',
      faceId: 'face-1',
      personId: 'maya',
      source: 'manual',
    })))

    await user.click(screen.getByRole('button', { name: 'No' }))
    expect(await screen.findByRole('img', { name: 'Third uncertain face' })).toBeInTheDocument()
    await waitFor(() => expect(
      (storedStates.get(namespace) as PeopleTimelineState).dismissedSuggestions,
    ).toContainEqual(expect.objectContaining({
      photoKey: 'photo:second',
      faceId: 'face-1',
      personId: 'maya',
    })))

    await user.click(screen.getByRole('button', { name: 'Not sure' }))
    expect(await screen.findByText('Review complete for now')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Review/ })).not.toBeInTheDocument()
  })

  it('opens the existing review flow from a face candidate', async () => {
    const namespace = 'people-face-candidate'
    const reviewBase = Array<number>(1_024).fill(1)
    const uncertainFace = reviewBase.map((value, index) =>
      value + (index % 2 === 0 ? -0.3 : 0.3),
    )
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(reviewBase) },
      faceScans: {
        'photo:candidate': faceScan(detectedFace('face-1', uncertainFace)),
      },
    }))
    const user = userEvent.setup()
    renderTimeline([
      capsulePhoto(
        'candidate',
        '2020-01-01T12:00:00.000Z',
        'Candidate face',
      ),
    ], namespace)

    const facesToName = await screen.findByRole('region', {
      name: 'Faces to name',
    })
    await user.click(within(facesToName).getByRole('button', {
      name: 'Review face suggested as Maya',
    }))

    expect(await screen.findByRole('img', { name: 'Candidate face' })).toBeInTheDocument()
    expect(screen.getByText('Is the outlined face Maya?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(scanReferencePortrait).not.toHaveBeenCalled()
    expect(scanTimelineFaces).not.toHaveBeenCalled()
  })

  it('accepts a batch of ordinary photos and opens All photos', async () => {
    const user = userEvent.setup()
    const onUploadPhotos = vi.fn(async (files: readonly File[]) => ({
      added: files.length,
      failed: 0,
    }))
    render(
      <MemoryRouter>
        <PeopleTimeline
          photos={[]}
          journalPhotos={[]}
          cacheNamespace="people-batch-upload"
          onUploadPhotos={onUploadPhotos}
          photoImportProgress={{ importing: false, completed: 0, total: 0 }}
        />
      </MemoryRouter>,
    )
    await screen.findByRole('heading', { name: 'Create your people' })

    const picker = screen.getByTestId('family-photo-input')
    expect(picker).toHaveAttribute('multiple')
    expect(picker).toHaveAttribute('tabindex', '-1')
    expect(picker).toHaveAttribute('aria-hidden', 'true')
    const pickerClick = vi.spyOn(picker, 'click')
    await user.click(screen.getAllByRole('button', { name: 'Add photos' })[0])
    expect(pickerClick).toHaveBeenCalledOnce()
    const first = new File(['one'], 'maya-one.jpg', { type: 'image/jpeg' })
    const second = new File(['two'], 'maya-two.png', { type: 'image/png' })
    await user.upload(picker, [first, second])

    await waitFor(() => expect(onUploadPhotos).toHaveBeenCalledWith([
      first,
      second,
    ]))
    expect(timelineChip('All photos')).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByRole('status')).toHaveTextContent(
      '2 photos added',
    )
    expect(picker).toHaveValue('')
  })

  it('keeps the hidden picker out of tab order and warns about partial batches', async () => {
    const user = userEvent.setup()
    const onUploadPhotos = vi.fn(async () => ({ added: 1, failed: 1 }))
    render(
      <MemoryRouter>
        <PeopleTimeline
          photos={[]}
          cacheNamespace="people-partial-upload"
          onUploadPhotos={onUploadPhotos}
        />
      </MemoryRouter>,
    )
    await screen.findByRole('heading', { name: 'Create your people' })

    await user.tab()
    expect(screen.getByRole('button', { name: 'Add person' })).toHaveFocus()
    await user.upload(screen.getByTestId('family-photo-input'), [
      new File(['ok'], 'ok.jpg', { type: 'image/jpeg' }),
      new File(['bad'], 'bad.heic', { type: 'image/heic' }),
    ])

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('1 photo added · 1 could not be added')
    expect(status).toHaveAttribute('data-error', 'true')
    expect(status).toHaveTextContent('Saved on this device')
  })

  it('shows batch progress and scans a new direct upload after importing ends', async () => {
    const namespace = 'people-direct-scan'
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
    }))
    const { rerender } = render(
      <MemoryRouter>
        <PeopleTimeline
          photos={[]}
          journalPhotos={[journalPhoto('new-direct')]}
          cacheNamespace={namespace}
          onUploadPhotos={vi.fn()}
          photoImportProgress={{ importing: true, completed: 1, total: 4 }}
        />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('progressbar', {
      name: 'Adding family photos',
    })).toHaveTextContent('Adding 2 of 4')
    expect(screen.getAllByRole('button', { name: 'Adding…' }).every(
      (button) => button.hasAttribute('disabled'),
    )).toBe(true)
    expect(scanTimelineFaces).not.toHaveBeenCalled()

    rerender(
      <MemoryRouter>
        <PeopleTimeline
          photos={[]}
          journalPhotos={[journalPhoto('new-direct')]}
          cacheNamespace={namespace}
          onUploadPhotos={vi.fn()}
          photoImportProgress={{ importing: false, completed: 4, total: 4 }}
        />
      </MemoryRouter>,
    )

    await waitFor(() => expect(scanTimelineFaces).toHaveBeenCalledTimes(1))
    expect(vi.mocked(scanTimelineFaces).mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        key: 'journal-photo:new-direct',
        kind: 'journal-photo',
      }),
    ])
  })

  it('does not enroll a person when the portrait scan is rejected', async () => {
    const user = userEvent.setup()
    vi.mocked(scanReferencePortrait).mockRejectedValue(
      new Error('More than one face was found. Choose a photo containing only this person.'),
    )
    renderTimeline([])
    await screen.findByRole('heading', { name: 'Create your people' })
    const addPersonButton = screen.getByRole('button', {
      name: 'Add person',
    })

    await user.click(addPersonButton)
    const form = screen.getByRole('form', { name: 'Add a person' })
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Maya')
    await user.upload(
      within(form).getByLabelText(/^Face photo/),
      new File(['group'], 'group.jpg', { type: 'image/jpeg' }),
    )
    await user.click(within(form).getByRole('button', { name: 'Add person' }))

    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'More than one face was found',
    )
    expect(screen.queryByRole('button', { name: 'Maya' })).not.toBeInTheDocument()
  })

  it('places group photos in Family and every matching person timeline automatically', async () => {
    const namespace = 'people-auto-family'
    storedStates.set(namespace, stateWith({
      people: [
        { id: 'maya', name: 'Maya', createdAt: '2026-01-01' },
        { id: 'leena', name: 'Leena', createdAt: '2026-01-01' },
      ],
      faceProfiles: {
        maya: faceProfile(mayaEmbedding),
        leena: faceProfile(leenaEmbedding),
      },
      faceScans: {
        'photo:maya': faceScan(detectedFace('face-1', mayaEmbedding)),
        'photo:family': faceScan(
          detectedFace('face-1', mayaEmbedding),
          detectedFace('face-2', leenaEmbedding),
        ),
      },
    }))
    const user = userEvent.setup()
    renderTimeline([
      capsulePhoto('family', '2024-01-01T12:00:00.000Z', 'Everyone together'),
      capsulePhoto('maya', '2020-01-01T12:00:00.000Z', 'Maya portrait'),
    ], namespace)

    expect(await screen.findByRole('img', { name: 'Everyone together' })).toBeInTheDocument()
    expect(screen.getByText('1 of 1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Maya' }))
    expect(await screen.findByRole('slider', {
      name: 'Timeline position for Maya',
    })).toHaveAttribute('aria-valuetext', '1 of 2, January 1, 2020')
    expect(screen.getByRole('figure', {
      name: 'Maya portrait, shared by Maya',
    })).toHaveClass('people-timeline__scrapbook-photo')

    await user.click(screen.getByRole('button', { name: 'Leena' }))
    expect(await screen.findByRole('img', { name: 'Everyone together' })).toBeInTheDocument()
    expect(screen.getByText('1 of 1')).toBeInTheDocument()
    expect(scanTimelineFaces).not.toHaveBeenCalled()
  })

  it('expands See all to reveal every face-matched album without selecting All photos', async () => {
    const namespace = 'people-see-all-albums'
    const people = ['maya', 'leena', 'omar'].map((id) => ({
      id,
      name: id[0]!.toLocaleUpperCase() + id.slice(1),
      createdAt: '2026-01-01',
    }))
    storedStates.set(namespace, stateWith({
      people,
      assignments: people.map(({ id }) => ({
        photoKey: `photo:${id}`,
        personId: id,
        source: 'manual' as const,
        confirmedAt: '2026-01-02T00:00:00.000Z',
      })),
    }))
    const user = userEvent.setup()
    renderTimeline(people.map(({ id, name }, index) => capsulePhoto(
      id,
      `202${index}-01-01T12:00:00.000Z`,
      `${name} portrait`,
    )), namespace)

    await screen.findByRole('button', {
      name: "Open Maya's scrapbook, 1 matched photo",
    })
    expect(screen.getByRole('button', {
      name: "Open Leena's scrapbook, 1 matched photo",
    })).toBeInTheDocument()
    expect(screen.queryByRole('button', {
      name: "Open Omar's scrapbook, 1 matched photo",
    })).not.toBeInTheDocument()

    const seeAll = screen.getByRole('button', { name: 'See all' })
    expect(seeAll).toHaveAttribute('aria-expanded', 'false')
    await user.click(seeAll)

    expect(screen.getByRole('button', {
      name: "Open Omar's scrapbook, 1 matched photo",
    })).toBeInTheDocument()
    expect(timelineChip('All photos')).toHaveAttribute('aria-pressed', 'false')
  })

  it('opens a recognized person in the dedicated scrapbook route when provided', async () => {
    const namespace = 'people-open-scrapbook'
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
      faceScans: {
        'photo:maya': faceScan(detectedFace('face-1', mayaEmbedding)),
      },
    }))
    const onOpenPersonAlbum = vi.fn()
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <PeopleTimeline
          photos={[capsulePhoto(
            'maya',
            '2020-01-01T12:00:00.000Z',
            'Maya portrait',
          )]}
          cacheNamespace={namespace}
          onOpenPersonAlbum={onOpenPersonAlbum}
        />
      </MemoryRouter>,
    )

    await user.click(await screen.findByRole('button', { name: 'Maya' }))
    expect(onOpenPersonAlbum).toHaveBeenCalledWith('maya')
  })

  it('opens a manually tagged person scrapbook without requiring a face profile', async () => {
    const namespace = 'people-open-manual-scrapbook'
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      assignments: [{
        photoKey: 'photo:maya',
        personId: 'maya',
        source: 'manual',
        confirmedAt: '2026-01-01T00:00:00.000Z',
      }],
    }))
    const onOpenPersonAlbum = vi.fn()
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <PeopleTimeline
          photos={[capsulePhoto(
            'maya',
            '2020-01-01T12:00:00.000Z',
            'Maya portrait',
          )]}
          cacheNamespace={namespace}
          onOpenPersonAlbum={onOpenPersonAlbum}
        />
      </MemoryRouter>,
    )

    await user.click(await screen.findByRole('button', { name: 'Maya' }))
    expect(onOpenPersonAlbum).toHaveBeenCalledWith('maya')
  })

  it('fills the dedicated scrapbook with every photo matched to that person', async () => {
    const namespace = 'people-scrapbook-photos'
    storedStates.set(namespace, stateWith({
      people: [
        { id: 'maya', name: 'Maya', createdAt: '2026-01-01' },
        { id: 'leena', name: 'Leena', createdAt: '2026-01-01' },
      ],
      faceProfiles: {
        maya: faceProfile(mayaEmbedding),
        leena: faceProfile(leenaEmbedding),
      },
      faceScans: {
        'photo:portrait': faceScan(detectedFace('face-1', mayaEmbedding)),
        'photo:family': faceScan(
          detectedFace('face-1', mayaEmbedding),
          detectedFace('face-2', leenaEmbedding),
        ),
      },
    }))

    render(
      <MemoryRouter>
        <PeopleTimeline
          photos={[
            capsulePhoto('portrait', '2020-01-01T12:00:00.000Z', 'Maya portrait'),
            capsulePhoto('family', '2024-01-01T12:00:00.000Z', 'Everyone together'),
          ]}
          cacheNamespace={namespace}
          initialPersonId="maya"
          personAlbumOpen
        />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: 'Maya' })).toBeInTheDocument()
    expect(screen.getByText('2 little moments, gathered together.')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Maya portrait' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Everyone together' })).toBeInTheDocument()
  })

  it('opens the existing person manager from a supported scrapbook route', async () => {
    const namespace = 'people-scrapbook-manage'
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
    }))
    const onClosePersonAlbum = vi.fn()
    const user = userEvent.setup()
    const view = render(
      <MemoryRouter>
        <PeopleTimeline
          photos={[]}
          cacheNamespace={namespace}
          initialPersonId="maya"
          personAlbumOpen
          onClosePersonAlbum={onClosePersonAlbum}
        />
      </MemoryRouter>,
    )

    await user.click(await screen.findByRole('button', { name: 'Manage Maya' }))
    expect(onClosePersonAlbum).toHaveBeenCalledOnce()

    view.rerender(
      <MemoryRouter>
        <PeopleTimeline
          photos={[]}
          cacheNamespace={namespace}
          onClosePersonAlbum={onClosePersonAlbum}
        />
      </MemoryRouter>,
    )

    const renameForm = await screen.findByRole('form', { name: 'Rename Maya' })
    await waitFor(() => expect(
      within(renameForm).getByRole('textbox', { name: 'Name' }),
    ).toHaveFocus())
  })

  it('does not treat duplicate detections of one person as a Family photo', async () => {
    const namespace = 'people-distinct-family'
    storedStates.set(namespace, stateWith({
      people: [
        { id: 'maya', name: 'Maya', createdAt: '2026-01-01' },
        { id: 'leena', name: 'Leena', createdAt: '2026-01-01' },
      ],
      faceProfiles: {
        maya: faceProfile(mayaEmbedding),
        leena: faceProfile(leenaEmbedding),
      },
      faceScans: {
        'photo:mirror': faceScan(
          detectedFace('face-1', mayaEmbedding),
          detectedFace('face-2', mayaEmbedding),
        ),
      },
    }))
    renderTimeline([
      capsulePhoto('mirror', '2024-01-01T12:00:00.000Z', 'Mirror photo'),
    ], namespace)

    expect(await screen.findByText('No group photos matched yet')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Mirror photo' })).not.toBeInTheDocument()
  })

  it('uses Review uploads for manual corrections that override recognition', async () => {
    const namespace = 'people-manual-correction'
    storedStates.set(namespace, stateWith({
      people: [
        { id: 'maya', name: 'Maya', createdAt: '2026-01-01' },
        { id: 'leena', name: 'Leena', createdAt: '2026-01-01' },
      ],
      faceProfiles: {
        maya: faceProfile(mayaEmbedding),
        leena: faceProfile(leenaEmbedding),
      },
      faceScans: {
        'photo:picnic': faceScan(detectedFace('face-1', mayaEmbedding)),
      },
    }))
    const user = userEvent.setup()
    renderTimeline([
      capsulePhoto('picnic', '2024-01-01T12:00:00.000Z', 'Family picnic'),
    ], namespace)
    await screen.findByText('No group photos matched yet')

    await user.click(timelineChip('All photos'))
    await screen.findByRole('img', { name: 'Family picnic' })
    await user.click(screen.getByRole('button', { name: 'People in this photo' }))
    expect(screen.getByRole('checkbox', { name: /Maya/ })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: /Leena/ }))

    await user.click(screen.getByRole('button', { name: 'Family' }))
    expect(await screen.findByRole('img', { name: 'Family picnic' })).toBeInTheDocument()

    await user.click(timelineChip('All photos'))
    const tagToggle = screen.getByRole('button', { name: 'People in this photo' })
    if (tagToggle.getAttribute('aria-expanded') !== 'true') await user.click(tagToggle)
    await user.click(screen.getByRole('checkbox', { name: /Maya/ }))
    await user.click(screen.getByRole('button', { name: 'Family' }))

    expect(await screen.findByText('No group photos matched yet')).toBeInTheDocument()
    await waitFor(() => expect(
      (storedStates.get(namespace) as PeopleTimelineState).dismissedSuggestions,
    ).toEqual([expect.objectContaining({
      photoKey: 'photo:picnic',
      personId: 'maya',
    })]))
  })

  it('automatically scans only ordinary photos that have not been checked', async () => {
    const namespace = 'people-incremental-scan'
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
      faceScans: {
        'photo:old': faceScan(detectedFace('face-1', mayaEmbedding)),
      },
    }))
    vi.mocked(scanTimelineFaces).mockImplementation(async (photos, checkpoint) => {
      const photo = photos[0]
      const scan = faceScan(detectedFace('face-1', mayaEmbedding))
      if (photo) await checkpoint?.({
        photoKey: photo.key,
        faceScan: scan,
        failed: false,
        completed: 1,
        total: photos.length,
      })
      return {
        faceScans: photo ? { [photo.key]: scan } : {},
        failedPhotoCount: 0,
        completedPhotoCount: photo ? 1 : 0,
      }
    })
    const user = userEvent.setup()
    renderTimeline([
      capsulePhoto('old', '2020-01-01T12:00:00.000Z', 'Old portrait'),
      capsulePhoto('new', '2024-01-01T12:00:00.000Z', 'New portrait'),
    ], namespace)

    await waitFor(() => expect(scanTimelineFaces).toHaveBeenCalledTimes(1))
    expect(vi.mocked(scanTimelineFaces).mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        key: 'photo:new',
        source: '/photos/new-thumb.jpg',
        scanSource: '/photos/new.jpg',
      }),
    ])
    await user.click(screen.getByRole('button', { name: 'Maya' }))
    expect(await screen.findByRole('slider', {
      name: 'Timeline position for Maya',
    })).toHaveAttribute('aria-valuetext', '1 of 2, January 1, 2020')
  })

  it('adds recognized photos from a newly opened Capsule to the matching slider once', async () => {
    const namespace = 'people-opened-capsule-scan'
    const oldPortrait = capsulePhoto(
      'old-portrait',
      '2020-01-01T12:00:00.000Z',
      'Maya in 2020',
    )
    const openedPortrait = capsulePhoto(
      'opened-portrait',
      '2024-01-01T12:00:00.000Z',
      'Maya from the Capsule',
    )
    const openedWithoutFamily = capsulePhoto(
      'opened-empty-room',
      '2025-01-01T12:00:00.000Z',
      'Empty room from the Capsule',
    )
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
      faceScans: {
        'photo:old-portrait': faceScan(detectedFace('face-1', mayaEmbedding)),
      },
    }))
    vi.mocked(scanTimelineFaces).mockImplementation(async (photos, checkpoint) => {
      const faceScans: Record<string, StoredPhotoFaceScan> = {}
      for (let index = 0; index < photos.length; index += 1) {
        const photo = photos[index]
        if (!photo) continue
        const scan = photo.id === openedPortrait.id
          ? faceScan(detectedFace('face-1', mayaEmbedding))
          : faceScan()
        faceScans[photo.key] = scan
        await checkpoint?.({
          photoKey: photo.key,
          faceScan: scan,
          failed: false,
          completed: index + 1,
          total: photos.length,
        })
      }
      return {
        faceScans,
        failedPhotoCount: 0,
        completedPhotoCount: photos.length,
      }
    })

    const renderView = (photos: UnlockedCapsulePhoto[]) => (
      <MemoryRouter>
        <PeopleTimeline
          photos={photos}
          cacheNamespace={namespace}
          initialPersonId="maya"
        />
      </MemoryRouter>
    )
    const view = render(renderView([oldPortrait]))

    expect(await screen.findByRole('slider', {
      name: 'Timeline position for Maya',
    })).toHaveAttribute('aria-valuetext', '1 of 1, January 1, 2020')
    expect(scanTimelineFaces).not.toHaveBeenCalled()

    const openedPhotos = [oldPortrait, openedPortrait, openedWithoutFamily]
    view.rerender(renderView(openedPhotos))

    await waitFor(() => expect(scanTimelineFaces).toHaveBeenCalledTimes(1))
    expect(vi.mocked(scanTimelineFaces).mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ key: 'photo:opened-portrait' }),
      expect.objectContaining({ key: 'photo:opened-empty-room' }),
    ])
    expect(await screen.findByText(
      'Photos are organized. New uploads will be matched automatically.',
    )).toBeInTheDocument()
    const updatedSlider = screen.getByRole('slider', {
      name: 'Timeline position for Maya',
    })
    expect(updatedSlider).toHaveAttribute(
      'aria-valuetext',
      '1 of 2, January 1, 2020',
    )
    expect(updatedSlider).toHaveAttribute('max', '1')

    fireEvent.change(updatedSlider, { target: { value: '1' } })
    expect(await screen.findByRole('img', {
      name: 'Maya from the Capsule',
    })).toBeInTheDocument()
    expect(screen.queryByRole('img', {
      name: 'Empty room from the Capsule',
    })).not.toBeInTheDocument()

    view.rerender(renderView([...openedPhotos]))

    expect(scanTimelineFaces).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('slider', {
      name: 'Timeline position for Maya',
    })).toHaveAttribute('max', '1')
  })

  it('preserves manual tags while clearing enrolled faces and detections', async () => {
    const namespace = 'people-clear-face-data'
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      assignments: [{
        photoKey: 'photo:portrait',
        personId: 'maya',
        source: 'manual',
        confirmedAt: '2026-01-01',
      }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
      faceScans: {
        'photo:portrait': faceScan(detectedFace('face-1', mayaEmbedding)),
      },
    }))
    const user = userEvent.setup()
    renderTimeline([
      capsulePhoto('portrait', '2020-01-01T12:00:00.000Z', 'Maya portrait'),
    ], namespace, { initialPersonId: 'maya' })
    await screen.findByRole('img', { name: 'Maya portrait' })

    await user.click(screen.getByRole('button', { name: 'Clear face data' }))
    const confirmation = screen.getByRole('group', { name: 'Confirm clear face data' })
    await user.click(within(confirmation).getByRole('button', { name: 'Clear' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Face references and detections have been cleared',
    )
    expect(screen.getByRole('img', { name: 'Maya portrait' })).toBeInTheDocument()
    await waitFor(() => expect(storedStates.get(namespace)).toEqual(
      expect.objectContaining({
        faceProfiles: {},
        faceScans: {},
        assignments: [expect.objectContaining({ source: 'manual' })],
      }),
    ))
  })

  it('edits an ordinary photo to an approximate year from Review uploads', async () => {
    const user = userEvent.setup()
    renderTimeline([
      capsulePhoto('childhood', '2008-08-12T12:00:00.000Z', 'At the park'),
    ])
    await screen.findByRole('heading', { name: 'Create your people' })
    await user.click(timelineChip('All photos'))
    await screen.findByRole('slider')

    await user.click(screen.getByRole('button', { name: 'Edit date' }))
    await user.click(screen.getByRole('button', { name: 'Year' }))
    const yearInput = screen.getByRole('spinbutton', { name: 'Approximate year' })
    await user.clear(yearInput)
    await user.type(yearInput, '1998')
    await user.click(screen.getByRole('button', { name: 'Save date' }))

    expect(screen.getByText('Around 1998')).toBeInTheDocument()
  })
})
