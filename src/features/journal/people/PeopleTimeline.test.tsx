import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnlockedCapsulePhoto } from '../capsuleJournalArchive'
import type { JournalPhoto, JournalPhotoImportResult } from '../journalPhotoTypes'
import { clearMemberSessionCaches } from '../../../app/memberSessionCache'
import { photoVisibilityKey, setContentHidden } from '../contentVisibility'
import { scanReferencePortrait, scanTimelineFaces } from './faceRecognition'
import { useGalleryScanSession } from './galleryScanSession'
import { PeopleTimeline } from './PeopleTimeline'
import { getPeopleTimelineSession } from './peopleTimelineSession'
import { emptyPeopleTimelineState, loadPeopleTimelineState } from './peopleTimelineStore'
import type {
  FaceProfile,
  PeopleTimelineState,
  StoredFaceDetection,
  StoredPhotoFaceScan,
} from './types'

const storedStates = vi.hoisted(() => new Map<string, unknown>())
const galleryScan = vi.hoisted(() => ({
  status: 'idle', total: 0, scanned: 0, failed: 0, pauseReason: undefined as string | undefined,
  error: '', requiresRestart: false, pause: vi.fn(), resume: vi.fn(), retry: vi.fn(),
}))

vi.mock('./galleryScanSession', () => ({
  useGalleryScanSession: vi.fn(() => galleryScan),
}))

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

const mayaEmbedding = Array<number>(1_024).fill(1)
const leenaEmbedding = Array<number>(1_024).fill(2)

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
    Object.assign(galleryScan, {
      status: 'idle', total: 0, scanned: 0, failed: 0, pauseReason: undefined,
      error: '', requiresRestart: false,
    })
    vi.mocked(useGalleryScanSession).mockClear()
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

  it('only deletes the selected owned Journal upload after explicit confirmation', async () => {
    const onDeletePhoto = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<MemoryRouter><PeopleTimeline
      photos={[]} journalPhotos={[journalPhoto('my-upload')]}
      cacheNamespace="delete-owner:family-a" initialPersonId="review-uploads"
      onDeletePhoto={onDeletePhoto}
    /></MemoryRouter>)
    await screen.findByRole('img', { name: 'Direct family upload' })
    await user.click(screen.getByRole('button', { name: 'Delete my photo' }))
    expect(onDeletePhoto).not.toHaveBeenCalled()
    expect(screen.getByRole('group', { name: 'Delete this photo?' }))
      .toHaveAccessibleDescription(/for everyone in your family/)
    await user.click(screen.getByRole('button', { name: 'Delete photo' }))
    expect(onDeletePhoto).toHaveBeenCalledExactlyOnceWith('my-upload')
  })

  it('offers confirmed deletion for an owned Capsule photo at the exact timeline selection', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const ownPhoto = { ...capsulePhoto('owned-capsule', '2024-01-01T12:00:00Z', 'My memory'), ownedByCurrentUser: true }
    render(<MemoryRouter><PeopleTimeline photos={[ownPhoto]} cacheNamespace="capsule-owner:family"
      initialPersonId="review-uploads" onDeleteCapsulePhoto={remove} /></MemoryRouter>)
    await screen.findByRole('slider')
    fireEvent.click(screen.getByRole('button', { name: 'Delete photo' }))
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByRole('group', { name: 'Delete this photo?' })).toHaveTextContent('family recap')
    fireEvent.click(within(screen.getByRole('group', { name: 'Delete this photo?' })).getByRole('button', { name: 'Delete photo' }))
    await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith('family-week', 'owned-capsule'))
  })

  it('can hide and restore someone else’s photo without calling shared deletion', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const photo = capsulePhoto('foreign-hide', '2024-01-01T12:00:00Z', 'Shared memory')
    render(<MemoryRouter><PeopleTimeline photos={[photo]} cacheNamespace="hide-foreign:family"
      initialPersonId="review-uploads" onDeleteCapsulePhoto={remove} /></MemoryRouter>)
    await screen.findByRole('slider')
    fireEvent.click(screen.getByRole('button', { name: 'Hide photo for me' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Hide this photo?' })).getByRole('button', { name: 'Hide photo' }))
    await waitFor(() => expect(screen.queryByRole('slider')).not.toBeInTheDocument())
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Restore hidden items (1)' }))
    await screen.findByRole('slider')
    expect(screen.getByRole('button', { name: 'Hide photo for me' })).toBeInTheDocument()
  })

  it.each(['another member', 'missing delete capability', 'Capsule copy'] as const)(
    'does not expose Journal deletion for %s', async (caseName) => {
      const onDeletePhoto = vi.fn().mockResolvedValue(undefined)
      const direct = { ...journalPhoto('same-id'), ownedByCurrentUser: caseName !== 'another member' }
      const capsule = { ...capsulePhoto('same-id', '2000-01-01T12:00:00.000Z', 'Owned Capsule copy'), ownedByCurrentUser: true }
      render(<MemoryRouter><PeopleTimeline
        photos={caseName === 'Capsule copy' ? [capsule] : []}
        journalPhotos={[direct]} cacheNamespace="delete-gating:family-a"
        initialPersonId="review-uploads"
        focusPhotoKey={caseName === 'Capsule copy' ? 'photo:same-id' : 'journal-photo:same-id'}
        onDeletePhoto={caseName === 'missing delete capability' ? undefined : onDeletePhoto}
      /></MemoryRouter>)
      await screen.findByRole('img', { name: caseName === 'Capsule copy' ? 'Owned Capsule copy' : 'Direct family upload' })
      expect(screen.queryByRole('button', { name: 'Delete my photo' })).not.toBeInTheDocument()
      expect(onDeletePhoto).not.toHaveBeenCalled()
    },
  )

  it('dismisses deletion confirmation when the slider changes photos, including when returning', async () => {
    const first = { ...journalPhoto('first'), caption: 'First upload', capturedAt: '2000-01-01T12:00:00.000Z' }
    const second = { ...journalPhoto('second'), caption: 'Second upload', capturedAt: '2001-01-01T12:00:00.000Z' }
    const onDeletePhoto = vi.fn().mockResolvedValue(undefined)
    render(<MemoryRouter><PeopleTimeline
      photos={[]} journalPhotos={[first, second]} cacheNamespace="delete-slider:family-a"
      initialPersonId="review-uploads" onDeletePhoto={onDeletePhoto}
    /></MemoryRouter>)
    await screen.findByRole('img', { name: 'First upload' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my photo' }))
    const slider = screen.getByRole('slider', { name: 'Timeline position for All photos' })
    fireEvent.change(slider, { target: { value: '1' } })
    expect(screen.getByRole('img', { name: 'Second upload' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Delete this photo?' })).not.toBeInTheDocument()
    fireEvent.change(slider, { target: { value: '0' } })
    expect(screen.getByRole('img', { name: 'First upload' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Delete this photo?' })).not.toBeInTheDocument()
    expect(onDeletePhoto).not.toHaveBeenCalled()
  })

  it('resets confirmation when a photo disappears or its ownership is revoked', async () => {
    const first = { ...journalPhoto('first'), caption: 'First upload' }
    const second = { ...journalPhoto('second'), caption: 'Second upload' }
    const onDeletePhoto = vi.fn().mockResolvedValue(undefined)
    const renderView = (photos: JournalPhoto[]) => <MemoryRouter><PeopleTimeline
      photos={[]} journalPhotos={photos} cacheNamespace="delete-replaced:family-a"
      initialPersonId="review-uploads" onDeletePhoto={onDeletePhoto}
    /></MemoryRouter>
    const view = render(renderView([first]))
    await screen.findByRole('img', { name: 'First upload' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my photo' }))
    view.rerender(renderView([second]))
    await screen.findByRole('img', { name: 'Second upload' })
    expect(screen.queryByRole('group', { name: 'Delete this photo?' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete my photo' }))
    view.rerender(renderView([{ ...second, ownedByCurrentUser: false }]))
    expect(screen.queryByRole('region', { name: 'Manage your photo' })).not.toBeInTheDocument()
    view.rerender(renderView([second]))
    expect(screen.getByRole('button', { name: 'Delete my photo' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Delete this photo?' })).not.toBeInTheDocument()
    expect(onDeletePhoto).not.toHaveBeenCalled()
  })

  it('does not carry confirmation across accounts even when both photos have the same ID', async () => {
    const oldDelete = deferred<void>()
    const onDeleteOld = vi.fn().mockReturnValue(oldDelete.promise)
    const onDeleteNew = vi.fn().mockResolvedValue(undefined)
    const renderView = (namespace: string, onDeletePhoto: (id: string) => Promise<void>) => <MemoryRouter><PeopleTimeline
      photos={[]} journalPhotos={[journalPhoto('same-id')]} cacheNamespace={namespace}
      initialPersonId="review-uploads" onDeletePhoto={onDeletePhoto}
    /></MemoryRouter>
    const view = render(renderView('account-a:family-a', onDeleteOld))
    await screen.findByRole('img', { name: 'Direct family upload' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my photo' }))
    view.rerender(renderView('account-b:family-b', onDeleteNew))
    await screen.findByRole('img', { name: 'Direct family upload' })
    expect(screen.queryByRole('group', { name: 'Delete this photo?' })).not.toBeInTheDocument()
    expect(onDeleteOld).not.toHaveBeenCalled()

    // A late completion from an already-started old-account request must also
    // leave the new account's confirmation and action state untouched.
    view.rerender(renderView('account-a:family-a', onDeleteOld))
    await screen.findByRole('img', { name: 'Direct family upload' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my photo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete photo' }))
    view.rerender(renderView('account-b:family-b', onDeleteNew))
    await screen.findByRole('img', { name: 'Direct family upload' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my photo' }))
    await act(async () => oldDelete.resolve(undefined))
    expect(screen.getByRole('group', { name: 'Delete this photo?' })).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByRole('button', { name: 'Keep photo' })).toHaveFocus()
    expect(onDeleteOld).toHaveBeenCalledExactlyOnceWith('same-id')
    expect(onDeleteNew).not.toHaveBeenCalled()
  })

  it('focuses the exact widget photo at its corrected All photos position and restores only on a new tap', async () => {
    const namespace = 'widget-exact-journal-photo'
    const sharedCapsulePhoto = capsulePhoto('same-id', '2023-01-01T12:00:00.000Z', 'Capsule with the same ID')
    const oldest = capsulePhoto('oldest', '2000-01-01T12:00:00.000Z', 'Oldest memory')
    const direct = journalPhoto('same-id')
    storedStates.set(namespace, stateWith({ dateOverrides: {
      'journal-photo:same-id': { precision: 'day', value: '2010-07-16' },
    } }))
    const renderView = (requestKey: string) => <MemoryRouter>
      <PeopleTimeline
        photos={[oldest, sharedCapsulePhoto]}
        journalPhotos={[direct]}
        cacheNamespace={namespace}
        initialPersonId="review-uploads"
        focusPhotoKey="journal-photo:same-id"
        focusMemoryId="journal-photo-same-id"
        focusRequestKey={requestKey}
        scrollToFocusedPhoto
      />
    </MemoryRouter>
    const view = render(renderView('tap-1'))
    await screen.findByRole('img', { name: 'Direct family upload' })
    const slider = screen.getByRole('slider', { name: 'Timeline position for All photos' })
    expect(slider).toHaveAttribute('aria-valuetext', '2 of 3, July 16, 2010')
    expect(timelineChip('All photos')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.change(slider, { target: { value: '0' } })
    expect(screen.getByRole('img', { name: 'Oldest memory' })).toBeInTheDocument()
    view.rerender(renderView('tap-1'))
    expect(screen.getByRole('img', { name: 'Oldest memory' })).toBeInTheDocument()

    view.rerender(renderView('tap-2'))
    await screen.findByRole('img', { name: 'Direct family upload' })
    expect(slider).toHaveValue('1')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit date' }))
    expect(screen.getByRole('form', { name: 'Edit photo date' })).toBeInTheDocument()
  })

  it('waits for a widget photo to hydrate without opening a separate viewer', async () => {
    const namespace = 'widget-delayed-journal-photo'
    const renderView = (photos: JournalPhoto[]) => <MemoryRouter>
      <PeopleTimeline
        photos={[]}
        journalPhotos={photos}
        cacheNamespace={namespace}
        initialPersonId="review-uploads"
        focusPhotoKey="journal-photo:later"
        focusRequestKey="tap-1"
      />
    </MemoryRouter>
    const view = render(renderView([]))
    await screen.findByText('Add your family photos')
    view.rerender(renderView([journalPhoto('later')]))
    expect(await screen.findByRole('img', { name: 'Direct family upload' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Timeline position for All photos' })).toHaveValue('0')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Photo memory')).not.toBeInTheDocument()
  })

  it('keeps a person filter chosen before local cache hydration instead of restoring the widget’s All request', async () => {
    const pendingCache = deferred<PeopleTimelineState>()
    vi.mocked(loadPeopleTimelineState).mockReturnValueOnce(pendingCache.promise)
    render(<MemoryRouter><PeopleTimeline
      photos={[capsulePhoto('memory', '2000-01-01T12:00:00.000Z', 'A memory')]}
      cacheNamespace="widget-person-choice-before-cache"
      initialPersonId="review-uploads"
      focusPhotoKey="photo:memory"
      focusRequestKey="tap-1"
    /></MemoryRouter>)
    expect(timelineChip('All photos')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(timelineChip('Family'))
    expect(timelineChip('Family')).toHaveAttribute('aria-pressed', 'true')
    await act(async () => pendingCache.resolve(emptyPeopleTimelineState()))
    expect(timelineChip('Family')).toHaveAttribute('aria-pressed', 'true')
    expect(timelineChip('All photos')).toHaveAttribute('aria-pressed', 'false')
  })

  it('does not hijack browsing if the requested widget photo arrives after the user moves the slider', async () => {
    const first = capsulePhoto('first', '2000-01-01T12:00:00.000Z', 'First photo')
    const second = capsulePhoto('second', '2001-01-01T12:00:00.000Z', 'Second photo')
    const later = capsulePhoto('later', '2002-01-01T12:00:00.000Z', 'Late widget photo')
    const renderView = (photos: UnlockedCapsulePhoto[]) => <MemoryRouter>
      <PeopleTimeline
        photos={photos}
        cacheNamespace="widget-user-browsing-wins"
        initialPersonId="review-uploads"
        focusPhotoKey="photo:later"
        focusRequestKey="tap-1"
      />
    </MemoryRouter>
    const view = render(renderView([first, second]))
    const slider = await screen.findByRole('slider', { name: 'Timeline position for All photos' })
    fireEvent.change(slider, { target: { value: '1' } })
    expect(screen.getByRole('img', { name: 'Second photo' })).toBeInTheDocument()
    view.rerender(renderView([first, second, later]))
    expect(slider).toHaveAttribute('max', '2')
    expect(screen.getByRole('img', { name: 'Second photo' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Late widget photo' })).not.toBeInTheDocument()
  })

  it('resolves capsule widget photos by stable photo key after the capsule ID changes', async () => {
    render(<MemoryRouter><PeopleTimeline
      photos={[{ ...capsulePhoto('retained-photo', '2022-01-01T12:00:00.000Z', 'Synced memory'), capsuleId: 'server-capsule' }]}
      cacheNamespace="widget-stable-capsule-photo"
      initialPersonId="review-uploads"
      focusPhotoKey="photo:retained-photo"
      focusMemoryId="capsule-old-local-capsule-retained-photo"
      focusRequestKey="tap-1"
    /></MemoryRouter>)
    expect(await screen.findByRole('img', { name: 'Synced memory' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Timeline position for All photos' })).toHaveValue('0')
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
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAttribute('autocorrect', 'off')
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAttribute('autocapitalize', 'words')
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

  it('keeps Add person usable while the gallery scanner runs and preserves its latest checkpoint during enrollment', async () => {
    const namespace = 'people-add-during-gallery-scan'
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
    }))
    Object.assign(galleryScan, { status: 'running', total: 4697, scanned: 8 })
    const pendingPortrait = deferred<Awaited<ReturnType<typeof scanReferencePortrait>>>()
    vi.mocked(scanReferencePortrait).mockReturnValue(pendingPortrait.promise)
    const user = userEvent.setup()
    renderTimeline([], namespace)
    await screen.findByRole('button', { name: 'Maya' })

    const opener = screen.getByRole('button', { name: 'Add person' })
    expect(screen.getByRole('progressbar', { name: 'Gallery photos checked' })).toHaveValue(8)
    expect(opener).toBeEnabled()
    await user.click(opener)
    const form = screen.getByRole('form', { name: 'Add a person' })
    const name = within(form).getByRole('textbox', { name: 'Name' })
    const portraits = within(form).getByLabelText(/^Face photos/)
    expect(name).toBeEnabled()
    expect(portraits).toBeEnabled()
    expect(vi.mocked(useGalleryScanSession).mock.lastCall?.[2]).toBe(true)
    await user.type(name, 'Leena')
    await user.upload(portraits, new File(['portrait'], 'leena.jpg', { type: 'image/jpeg' }))
    await user.click(within(form).getByRole('button', { name: 'Add person' }))
    expect(scanReferencePortrait).toHaveBeenCalledTimes(1)

    const checkpoint = faceScan(detectedFace('gallery-face', mayaEmbedding))
    await act(async () => {
      // The library owner can publish a completed batch independently of this
      // form's asynchronous reference scan. Enrollment must merge into it.
      await getPeopleTimelineSession(namespace).mergeScans({
        'journal-photo:device-gallery:historic': checkpoint,
      })
      pendingPortrait.resolve({ embedding: leenaEmbedding, quality: 0.9 })
      await pendingPortrait.promise
    })

    expect(await screen.findByRole('button', { name: 'Leena' })).toBeInTheDocument()
    await waitFor(() => {
      const state = storedStates.get(namespace) as PeopleTimelineState
      expect(state.people.map(({ name: personName }) => personName)).toEqual(['Maya', 'Leena'])
      expect(state.faceScans['journal-photo:device-gallery:historic']).toEqual(checkpoint)
      const leena = state.people.find(({ name: personName }) => personName === 'Leena')!
      expect(state.faceProfiles[leena.id]?.references[0]?.embedding).toEqual(leenaEmbedding)
    })
    expect(vi.mocked(useGalleryScanSession).mock.lastCall?.[2]).toBe(false)
    expect(scanTimelineFaces).not.toHaveBeenCalled()
  })

  it('interrupts an ordinary photo scan to open Add person without disabling its form', async () => {
    const namespace = 'people-add-interrupts-upload-scan'
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
    }))
    const pendingScan = deferred<Awaited<ReturnType<typeof scanTimelineFaces>>>()
    vi.mocked(scanTimelineFaces).mockReturnValue(pendingScan.promise)
    const user = userEvent.setup()
    renderTimeline([capsulePhoto('pending', '2024-01-01T12:00:00Z', 'Pending portrait')], namespace)
    await waitFor(() => expect(scanTimelineFaces).toHaveBeenCalledTimes(1), { timeout: 2000 })
    const signal = vi.mocked(scanTimelineFaces).mock.calls[0]?.[2]
    expect(signal?.aborted).toBe(false)
    const opener = screen.getByRole('button', { name: 'Add person' })
    expect(opener).toBeEnabled()
    await user.click(opener)
    expect(signal?.aborted).toBe(true)
    const form = screen.getByRole('form', { name: 'Add a person' })
    expect(within(form).getByRole('textbox', { name: 'Name' })).toBeEnabled()
    expect(within(form).getByLabelText(/^Face photos/)).toBeEnabled()
    expect(within(form).getByRole('button', { name: 'Add person' })).toBeEnabled()
    await act(async () => {
      pendingScan.resolve({ faceScans: {}, completedPhotoCount: 0, failedPhotoCount: 0 })
      await pendingScan.promise
    })
    expect(screen.getByRole('form', { name: 'Add a person' })).toBeInTheDocument()
    expect(vi.mocked(useGalleryScanSession).mock.lastCall?.[2]).toBe(true)
  })

  it('does not evict the new member session when enrollment from a departed member finishes', async () => {
    const namespaceA = 'people-pending-enrollment:member-a'
    const namespaceB = 'people-pending-enrollment:member-b'
    storedStates.set(namespaceB, stateWith({
      people: [{ id: 'omar', name: 'Omar', createdAt: '2026-01-01' }],
      faceProfiles: { omar: faceProfile(mayaEmbedding) },
    }))
    const pendingPortrait = deferred<Awaited<ReturnType<typeof scanReferencePortrait>>>()
    vi.mocked(scanReferencePortrait).mockReturnValue(pendingPortrait.promise)
    const user = userEvent.setup()
    const viewFor = (namespace: string) => <MemoryRouter><PeopleTimeline
      photos={[]} cacheNamespace={namespace}
    /></MemoryRouter>
    const view = render(viewFor(namespaceA))
    await user.click(await screen.findByRole('button', { name: 'Add person' }))
    const form = screen.getByRole('form', { name: 'Add a person' })
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Leena')
    await user.upload(within(form).getByLabelText(/^Face photos/),
      new File(['portrait'], 'leena.jpg', { type: 'image/jpeg' }))
    await user.click(within(form).getByRole('button', { name: 'Add person' }))
    expect(scanReferencePortrait).toHaveBeenCalledTimes(1)

    view.rerender(viewFor(namespaceB))
    await screen.findByRole('button', { name: 'Omar' })
    const currentSession = getPeopleTimelineSession(namespaceB)
    expect(currentSession.getSnapshot().ready).toBe(true)
    await act(async () => {
      pendingPortrait.resolve({ embedding: leenaEmbedding, quality: 0.9 })
      await pendingPortrait.promise
    })

    expect(getPeopleTimelineSession(namespaceB)).toBe(currentSession)
    expect(currentSession.getSnapshot()).toMatchObject({
      ready: true,
      state: { people: [{ id: 'omar', name: 'Omar' }] },
    })
    expect(screen.getByRole('button', { name: 'Omar' })).toBeInTheDocument()
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

  it('keeps Family separate and exposes ordinary uploads through All photos, not the optional face review', async () => {
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
    const mediumA = reviewBase.map((value) => value + 0.18)
    const mediumB = reviewBase.map((value, index) =>
      value + (index % 2 === 0 ? -0.18 : 0.18),
    )
    const mediumC = reviewBase.map((value, index) =>
      value + (index % 3 === 0 ? -0.18 : 0.18),
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
      name: 'Possible matches',
    })
    expect(within(facesToName).getByRole('button', {
      name: 'Open review',
    })).toBeInTheDocument()
    expect(within(facesToName).getAllByRole('button', {
      name: 'Review face suggested as Maya',
    })).toHaveLength(3)

    const reviewChip = await screen.findByRole('button', { name: 'Review 3 possible matches (optional)' })
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
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Review/ })).not.toBeInTheDocument()
  })

  it('opens the existing review flow from a face candidate', async () => {
    const namespace = 'people-face-candidate'
    const reviewBase = Array<number>(1_024).fill(1)
    const uncertainFace = reviewBase.map((value, index) =>
      value + (index % 2 === 0 ? -0.18 : 0.18),
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
      name: 'Possible matches',
    })
    await user.click(within(facesToName).getByRole('button', {
      name: 'Review face suggested as Maya',
    }))

    expect(await screen.findByRole('img', { name: 'Candidate face' })).toBeInTheDocument()
    expect(screen.getByText('Is the outlined face Maya?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review 1 possible match (optional)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(scanReferencePortrait).not.toHaveBeenCalled()
    expect(scanTimelineFaces).not.toHaveBeenCalled()
  })

  it('automatically files clear matches, keeps weak photos, and counts only visible borderline candidates in optional review', async () => {
    const namespace = 'people-optional-review-policy'
    const reference = Array<number>(1_024).fill(1)
    const weak = reference.map((value, index) => value + (index % 2 ? 0.3 : -0.3))
    const borderline = reference.map((value, index) => value + (index % 2 ? 0.18 : -0.18))
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(reference) },
      faceScans: {
        'photo:clear': faceScan(detectedFace('face-clear', reference)),
        'photo:weak': faceScan(detectedFace('face-weak', weak)),
        'photo:borderline': faceScan(detectedFace('face-borderline', borderline)),
        'photo:hidden': faceScan(detectedFace('face-hidden', borderline)),
        'photo:no-longer-available': faceScan(detectedFace('face-missing', borderline)),
      },
    }))
    setContentHidden(namespace, photoVisibilityKey('hidden', 'capsule-photo'), true)
    const user = userEvent.setup()
    renderTimeline([
      capsulePhoto('clear', '2020-01-01T12:00:00Z', 'Automatically matched photo'),
      capsulePhoto('weak', '2021-01-01T12:00:00Z', 'Weak match kept in library'),
      capsulePhoto('borderline', '2022-01-01T12:00:00Z', 'Possible family face'),
      capsulePhoto('hidden', '2023-01-01T12:00:00Z', 'Hidden photo'),
    ], namespace)

    expect(await screen.findByRole('button', { name: "Open Maya's scrapbook, 1 matched photo" })).toBeInTheDocument()
    const review = screen.getByRole('button', { name: 'Review 1 possible match (optional)' })
    const preview = screen.getByRole('region', { name: 'Possible matches' })
    expect(preview).toHaveTextContent('1 possible match · optional')
    expect(preview).toHaveTextContent('Strong matches are added automatically, and you can correct them. Other photos stay in All photos.')
    expect(within(preview).getAllByRole('button', { name: 'Review face suggested as Maya' })).toHaveLength(1)
    expect(screen.queryByText('Review all')).not.toBeInTheDocument()

    await user.click(timelineChip('All photos'))
    const slider = screen.getByRole('slider', { name: 'Timeline position for All photos' })
    expect(slider).toHaveAttribute('max', '2')
    fireEvent.change(slider, { target: { value: '1' } })
    expect(screen.getByRole('img', { name: 'Weak match kept in library' })).toBeInTheDocument()
    expect(screen.queryByText('Is the outlined face Maya?')).not.toBeInTheDocument()

    await user.click(review)
    expect(screen.getByRole('img', { name: 'Possible family face' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Timeline position for Possible matches' })).toHaveAttribute('max', '0')
    await user.click(screen.getByRole('button', { name: 'Not sure' }))
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument()
    expect(screen.getByText('Strong matches were added automatically. You can correct a person label without removing the photo.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Review \d/ })).not.toBeInTheDocument()
    await user.click(timelineChip('All photos'))
    expect(screen.getByRole('slider', { name: 'Timeline position for All photos' })).toHaveAttribute('max', '2')
  })

  it('corrects an inferred person label with confirmation, preserves other tags and originals, and remembers it after remount', async () => {
    const namespace = 'correct-automatic-person'
    const original = capsulePhoto('mistaken', '2020-01-01T12:00:00Z', 'Original family photo')
    const manualTag = { photoKey: 'photo:mistaken', personId: 'leena', source: 'manual' as const, confirmedAt: '2026-01-02' }
    storedStates.set(namespace, stateWith({
      people: [
        { id: 'maya', name: 'Maya', createdAt: '2026-01-01' },
        { id: 'leena', name: 'Leena', createdAt: '2026-01-01' },
      ],
      faceProfiles: { maya: faceProfile(mayaEmbedding), leena: faceProfile(leenaEmbedding) },
      faceScans: { 'photo:mistaken': faceScan(detectedFace('face', mayaEmbedding)) },
      assignments: [manualTag],
    }))
    const user = userEvent.setup()
    const first = renderTimeline([original], namespace, { initialPersonId: 'maya' })
    await screen.findByRole('img', { name: original.caption })
    await user.click(screen.getByRole('button', { name: 'Correct automatic match for Maya in Original family photo' }))
    expect(screen.getByRole('img', { name: original.caption })).toBeInTheDocument()
    expect((storedStates.get(namespace) as PeopleTimelineState).dismissedSuggestions).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Not Maya' }))
    await waitFor(() => expect((storedStates.get(namespace) as PeopleTimelineState).dismissedSuggestions)
      .toContainEqual(expect.objectContaining({ photoKey: 'photo:mistaken', personId: 'maya' })))
    const saved = storedStates.get(namespace) as PeopleTimelineState
    expect(saved.assignments).toEqual([manualTag])
    expect(saved.faceScans['photo:mistaken'].faces).toHaveLength(1)
    await user.click(timelineChip('All photos'))
    expect(screen.getByRole('img', { name: original.caption })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Correct automatic match for Leena/ })).not.toBeInTheDocument()
    first.unmount()
    clearMemberSessionCaches(namespace)
    renderTimeline([original], namespace, { initialPersonId: 'maya' })
    expect(await screen.findByText('No matches for Maya yet')).toBeInTheDocument()
    await user.click(timelineChip('All photos'))
    expect(screen.getByRole('img', { name: original.caption })).toBeInTheDocument()
    expect(original.image).toBe('/photos/mistaken.jpg')
  })

  it('does not silently remove a manual confirmation and remembers an explicit manual untag so it cannot auto-reappear', async () => {
    const namespace = 'correct-manual-person'
    const original = capsulePhoto('confirmed', '2020-01-01T12:00:00Z', 'Manually tagged photo')
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
      faceScans: { 'photo:confirmed': faceScan(detectedFace('face', mayaEmbedding)) },
      assignments: [{ photoKey: 'photo:confirmed', personId: 'maya', source: 'manual', confirmedAt: '2026-01-02' }],
    }))
    const user = userEvent.setup()
    renderTimeline([original], namespace, { initialPersonId: 'review-uploads' })
    await screen.findByRole('img', { name: original.caption })
    expect(screen.queryByRole('button', { name: /Correct automatic match/ })).not.toBeInTheDocument()
    expect((storedStates.get(namespace) as PeopleTimelineState).assignments).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'People in this photo' }))
    const tag = screen.getByRole('checkbox', { name: /Maya/ })
    expect(tag.closest('label')).toHaveTextContent('Confirmed by you')
    expect(tag).toBeChecked()
    await user.click(tag)
    await waitFor(() => expect((storedStates.get(namespace) as PeopleTimelineState).assignments).toEqual([]))
    expect((storedStates.get(namespace) as PeopleTimelineState).dismissedSuggestions)
      .toContainEqual(expect.objectContaining({ photoKey: 'photo:confirmed', personId: 'maya' }))
    expect(screen.getByRole('checkbox', { name: 'Maya' })).not.toBeChecked()
    expect(screen.getByRole('img', { name: original.caption })).toBeInTheDocument()
  })

  it('offers the same per-photo automatic correction inside a routed person scrapbook', async () => {
    const namespace = 'correct-routed-scrapbook'
    const original = capsulePhoto('routed', '2020-01-01T12:00:00Z', 'Routed original')
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
      faceScans: { 'photo:routed': faceScan(detectedFace('face', mayaEmbedding)) },
    }))
    const user = userEvent.setup()
    render(<MemoryRouter><PeopleTimeline photos={[original]} cacheNamespace={namespace}
      initialPersonId="maya" personAlbumOpen onClosePersonAlbum={vi.fn()} /></MemoryRouter>)
    expect(await screen.findByRole('img', { name: original.caption })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Correct automatic match for Maya in Routed original' }))
    await user.click(screen.getByRole('button', { name: 'Not Maya' }))
    expect(await screen.findByText('A page waiting for memories')).toBeInTheDocument()
    await waitFor(() => expect((storedStates.get(namespace) as PeopleTimelineState).dismissedSuggestions)
      .toContainEqual(expect.objectContaining({ photoKey: 'photo:routed', personId: 'maya' })))
    expect((storedStates.get(namespace) as PeopleTimelineState).faceScans['photo:routed']).toBeDefined()
    expect(original.image).toBe('/photos/routed.jpg')
  })

  it('adds a partial batch directly to the open scrapbook without any recognized face', async () => {
    const namespace = 'targeted-scrapbook'
    storedStates.set(namespace, stateWith({ people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }] }))
    const user = userEvent.setup()
    function UploadHarness() {
      const [photos, setPhotos] = useState<JournalPhoto[]>([])
      return <MemoryRouter><PeopleTimeline photos={[]} journalPhotos={photos}
        cacheNamespace={namespace} initialPersonId="maya" personAlbumOpen
        onUploadPhotos={async () => {
          setPhotos([journalPhoto('saved-only')])
          return { added: 1, failed: 1, photoIds: ['saved-only'] }
        }} /></MemoryRouter>
    }
    render(<UploadHarness />)
    await user.click(await screen.findByRole('button', { name: 'Add photos to Maya’s scrapbook' }))
    await user.upload(screen.getByTestId('family-photo-input'), [
      new File(['yes'], 'yes.jpg', { type: 'image/jpeg' }),
      new File(['bad'], 'bad.heic', { type: 'image/heic' }),
    ])
    expect(await screen.findByRole('img', { name: 'Direct family upload' })).toBeInTheDocument()
    expect(await screen.findByText('1 photo added to Maya’s scrapbook · 1 could not be added.')).toHaveAttribute('data-error', 'true')
    const saved = storedStates.get(namespace) as PeopleTimelineState
    expect(saved.assignments).toEqual([expect.objectContaining({ photoKey: 'journal-photo:saved-only', personId: 'maya', source: 'manual' })])
    expect(saved.assignments[0]?.faceId).toBeUndefined()
    expect(saved.faceProfiles).toEqual({})
    expect(scanReferencePortrait).not.toHaveBeenCalled()
  })

  it('distinguishes actual scrapbook uploads in the person manager from private face samples', async () => {
    const namespace = 'targeted-manager'
    storedStates.set(namespace, stateWith({ people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }] }))
    const user = userEvent.setup()
    const upload = vi.fn(async () => ({ added: 0, failed: 0, photoIds: ['already-saved'] }))
    render(<MemoryRouter><PeopleTimeline photos={[]} journalPhotos={[journalPhoto('already-saved')]}
      cacheNamespace={namespace} initialPersonId="maya" onUploadPhotos={upload} /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Rename or remove Maya' }))
    const manager = screen.getByRole('region', { name: 'Manage Maya' })
    expect(within(manager).getByText(/Face samples are scanned, never stored or added/)).toBeInTheDocument()
    await user.click(within(manager).getByRole('button', { name: 'Add scrapbook photos' }))
    await user.upload(screen.getByTestId('family-photo-input'), new File(['photo'], 'existing.jpg', { type: 'image/jpeg' }))
    expect(await within(manager).findByText('1 photo added to Maya’s scrapbook.')).toBeInTheDocument()
    expect(upload).toHaveBeenCalledOnce()
    expect(scanReferencePortrait).not.toHaveBeenCalled()
    expect(timelineChip('All photos')).toHaveAttribute('aria-pressed', 'false')
    expect((storedStates.get(namespace) as PeopleTimelineState).assignments).toHaveLength(1)
  })

  it('shows a targeted upload failure and releases the picker without adding phantom membership', async () => {
    const namespace = 'targeted-failure'
    storedStates.set(namespace, stateWith({ people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }] }))
    const user = userEvent.setup()
    render(<MemoryRouter><PeopleTimeline photos={[]} cacheNamespace={namespace} initialPersonId="maya" personAlbumOpen
      onUploadPhotos={vi.fn().mockRejectedValue(new Error('storage full'))} /></MemoryRouter>)
    const button = await screen.findByRole('button', { name: 'Add photos to Maya’s scrapbook' })
    await user.click(button)
    await user.upload(screen.getByTestId('family-photo-input'), new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }))
    expect(await screen.findByText(/Those photos could not be saved/)).toHaveAttribute('data-error', 'true')
    expect(button).toBeEnabled()
    expect((storedStates.get(namespace) as PeopleTimelineState).assignments).toEqual([])
  })

  it('finishes a captured scrapbook upload after leaving the tab and displays it on return', async () => {
    const namespace = 'targeted-tab-return'
    storedStates.set(namespace, stateWith({ people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }] }))
    const pending = deferred<JournalPhotoImportResult>()
    const user = userEvent.setup()
    const first = render(<MemoryRouter><PeopleTimeline photos={[]} cacheNamespace={namespace} initialPersonId="maya" personAlbumOpen
      onUploadPhotos={() => pending.promise} /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Add photos to Maya’s scrapbook' }))
    await user.upload(screen.getByTestId('family-photo-input'), new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }))
    first.unmount()
    await act(async () => { pending.resolve({ added: 1, failed: 0, photoIds: ['finished-later'] }) })
    await waitFor(() => expect((storedStates.get(namespace) as PeopleTimelineState).assignments)
      .toContainEqual(expect.objectContaining({ photoKey: 'journal-photo:finished-later', personId: 'maya' })))
    render(<MemoryRouter><PeopleTimeline photos={[]} journalPhotos={[journalPhoto('finished-later')]}
      cacheNamespace={namespace} initialPersonId="maya" personAlbumOpen /></MemoryRouter>)
    expect(await screen.findByRole('img', { name: 'Direct family upload' })).toBeInTheDocument()
  })

  it('does not finish membership after its private account session was cleared', async () => {
    const namespace = 'targeted-disposed-account'
    storedStates.set(namespace, stateWith({ people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }] }))
    const pending = deferred<JournalPhotoImportResult>()
    const user = userEvent.setup()
    const first = render(<MemoryRouter><PeopleTimeline photos={[]} cacheNamespace={namespace} initialPersonId="maya" personAlbumOpen
      onUploadPhotos={() => pending.promise} /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Add photos to Maya’s scrapbook' }))
    await user.upload(screen.getByTestId('family-photo-input'), new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }))
    first.unmount()
    clearMemberSessionCaches(namespace)
    await act(async () => { pending.resolve({ added: 1, failed: 0, photoIds: ['old-private'] }) })
    expect((storedStates.get(namespace) as PeopleTimelineState).assignments).toEqual([])
  })

  it('rejects an OS picker result that returns after the account changes', async () => {
    const one = 'picker-account-one'
    const two = 'picker-account-two'
    for (const namespace of [one, two]) storedStates.set(namespace, stateWith({ people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }] }))
    const user = userEvent.setup()
    const upload = vi.fn(async () => ({ added: 1, failed: 0, photoIds: ['private'] }))
    const view = (namespace: string) => <MemoryRouter><PeopleTimeline photos={[]} cacheNamespace={namespace}
      initialPersonId="maya" personAlbumOpen onUploadPhotos={upload} /></MemoryRouter>
    const { rerender } = render(view(one))
    await user.click(await screen.findByRole('button', { name: 'Add photos to Maya’s scrapbook' }))
    rerender(view(two))
    await screen.findByRole('button', { name: 'Add photos to Maya’s scrapbook' })
    await user.upload(screen.getByTestId('family-photo-input'), new File(['private'], 'private.jpg', { type: 'image/jpeg' }))
    expect(upload).not.toHaveBeenCalled()
    expect((storedStates.get(two) as PeopleTimelineState).assignments).toEqual([])
  })

  it('keeps the person captured by the picker if another scrapbook opens while importing', async () => {
    const namespace = 'targeted-other-person'
    storedStates.set(namespace, stateWith({ people: [
      { id: 'maya', name: 'Maya', createdAt: '2026-01-01' },
      { id: 'leena', name: 'Leena', createdAt: '2026-01-01' },
    ] }))
    const pending = deferred<JournalPhotoImportResult>()
    const user = userEvent.setup()
    const view = (personId: string) => <MemoryRouter><PeopleTimeline photos={[]} cacheNamespace={namespace}
      initialPersonId={personId} personAlbumOpen onUploadPhotos={() => pending.promise} /></MemoryRouter>
    const { rerender } = render(view('maya'))
    await user.click(await screen.findByRole('button', { name: 'Add photos to Maya’s scrapbook' }))
    await user.upload(screen.getByTestId('family-photo-input'), new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }))
    rerender(view('leena'))
    await act(async () => { pending.resolve({ added: 1, failed: 0, photoIds: ['maya-photo'] }) })
    await waitFor(() => expect((storedStates.get(namespace) as PeopleTimelineState).assignments)
      .toEqual([expect.objectContaining({ photoKey: 'journal-photo:maya-photo', personId: 'maya' })]))
  })

  it('reports saved but unlinked photos honestly when an upload adapter omits its successful IDs', async () => {
    const namespace = 'targeted-missing-ids'
    storedStates.set(namespace, stateWith({ people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }] }))
    const user = userEvent.setup()
    render(<MemoryRouter><PeopleTimeline photos={[]} cacheNamespace={namespace} initialPersonId="maya" personAlbumOpen
      onUploadPhotos={async () => ({ added: 1, failed: 0 })} /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Add photos to Maya’s scrapbook' }))
    await user.upload(screen.getByTestId('family-photo-input'), new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }))
    expect(await screen.findByText(/The photos are saved in All photos, but could not be linked/)).toHaveAttribute('data-error', 'true')
    expect((storedStates.get(namespace) as PeopleTimelineState).assignments).toEqual([])
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

    await waitFor(
      () => expect(scanTimelineFaces).toHaveBeenCalledTimes(1),
      { timeout: 2_000 },
    )
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

  it('shows any two of four family members with manual labels even without face enrollment, excluding solo and unaccepted labels', async () => {
    const namespace = 'family-any-two-without-enrollment'
    const people = ['maya', 'leena', 'sam', 'ria'].map((id) => ({ id, name: id, createdAt: '2026-01-01' }))
    storedStates.set(namespace, stateWith({
      people,
      faceProfiles: {},
      faceScans: {},
      assignments: [
        { photoKey: 'photo:pair', personId: 'maya', source: 'manual', confirmedAt: '2026-01-01' },
        { photoKey: 'photo:pair', personId: 'leena', source: 'manual', confirmedAt: '2026-01-01' },
        { photoKey: 'photo:solo', personId: 'maya', source: 'manual', confirmedAt: '2026-01-01' },
        { photoKey: 'photo:solo', personId: 'maya', faceId: 'another-detection', source: 'manual', confirmedAt: '2026-01-01' },
        { photoKey: 'photo:unaccepted', personId: 'sam', source: 'face-suggestion', confirmedAt: '2026-01-01' },
        { photoKey: 'photo:unaccepted', personId: 'ria', source: 'face-suggestion', confirmedAt: '2026-01-01' },
      ],
    }))
    const user = userEvent.setup()
    renderTimeline([
      capsulePhoto('pair', '2020-01-01T12:00:00Z', 'Two of our four family members'),
      capsulePhoto('solo', '2021-01-01T12:00:00Z', 'One family member'),
      capsulePhoto('unaccepted', '2022-01-01T12:00:00Z', 'Unaccepted guesses'),
    ], namespace)

    expect(await screen.findByRole('img', { name: 'Two of our four family members' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Timeline position for Family' })).toHaveAttribute('max', '0')
    expect(screen.queryByRole('img', { name: 'One family member' })).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Unaccepted guesses' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Create your people' })).toBeInTheDocument()
    expect(scanTimelineFaces).not.toHaveBeenCalled()
    await user.click(timelineChip('All photos'))
    expect(screen.getByRole('slider', { name: 'Timeline position for All photos' })).toHaveAttribute('max', '2')
    expect((storedStates.get(namespace) as PeopleTimelineState).faceProfiles).toEqual({})
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

  it.each(['automatic', 'manual'] as const)('leaves linked gallery photos to the session-owned scanner during %s upload checking', async (mode) => {
    const namespace = `people-gallery-not-route-scanned-${mode}`
    storedStates.set(namespace, stateWith({
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      faceProfiles: { maya: faceProfile(mayaEmbedding) },
    }))
    const linkedPhoto: JournalPhoto = {
      ...journalPhoto('device-gallery:historic'),
      origin: 'device-gallery',
      capturedAt: '2001-02-03T12:00:00Z',
      image: `bubble-gallery:historic?scope=${namespace}`,
      thumbnail: `bubble-gallery:historic?scope=${namespace}`,
      ownedByCurrentUser: false,
      syncStatus: 'local',
    }
    render(<MemoryRouter><PeopleTimeline
      photos={[capsulePhoto('new-upload', '2026-01-01T12:00:00Z', 'New upload')]}
      journalPhotos={[linkedPhoto]}
      cacheNamespace={namespace}
    /></MemoryRouter>)
    await screen.findByRole('button', { name: 'Maya' })
    if (mode === 'manual') fireEvent.click(screen.getByRole('button', { name: 'Check new photos' }))
    await waitFor(() => expect(scanTimelineFaces).toHaveBeenCalledTimes(1), { timeout: 2000 })
    expect(vi.mocked(scanTimelineFaces).mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ key: 'photo:new-upload' }),
    ])
    expect(vi.mocked(useGalleryScanSession).mock.lastCall?.[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'journal-photo:device-gallery:historic', origin: 'device-gallery', canScanFaces: true,
      }),
    ]))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Up to date' })).toBeDisabled())
    expect(getPeopleTimelineSession(namespace).getSnapshot().state.faceScans)
      .not.toHaveProperty('journal-photo:device-gallery:historic')
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

    await waitFor(
      () => expect(scanTimelineFaces).toHaveBeenCalledTimes(1),
      { timeout: 2_000 },
    )
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

  it('does not start a settling automatic scan after a quick route unmount', async () => {
    vi.useFakeTimers()
    try {
      const namespace = 'people-cancel-settling-scan'
      storedStates.set(namespace, stateWith({
        people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
        faceProfiles: { maya: faceProfile(mayaEmbedding) },
      }))
      const view = renderTimeline([
        capsulePhoto('pending', '2024-01-01T12:00:00.000Z', 'Pending portrait'),
      ], namespace)

      await act(async () => {
        await Promise.resolve()
      })
      await act(async () => {
        vi.advanceTimersByTime(699)
      })
      expect(scanTimelineFaces).not.toHaveBeenCalled()

      view.unmount()
      await act(async () => {
        vi.advanceTimersByTime(1)
        await Promise.resolve()
      })

      expect(scanTimelineFaces).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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

    await waitFor(
      () => expect(scanTimelineFaces).toHaveBeenCalledTimes(1),
      { timeout: 2_000 },
    )
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
      people: [
        { id: 'maya', name: 'Maya', createdAt: '2026-01-01' },
        { id: 'leena', name: 'Leena', createdAt: '2026-01-01' },
      ],
      assignments: [{
        photoKey: 'photo:portrait',
        personId: 'maya',
        source: 'manual',
        confirmedAt: '2026-01-01',
      }, {
        photoKey: 'photo:portrait',
        personId: 'leena',
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
        assignments: [expect.objectContaining({ source: 'manual' }), expect.objectContaining({ source: 'manual' })],
      }),
    ))
    await user.click(timelineChip('Family'))
    expect(screen.getByRole('img', { name: 'Maya portrait' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Timeline position for Family' })).toHaveAttribute('max', '0')
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
    expect(yearInput).toHaveAttribute('inputmode', 'numeric')
    await user.clear(yearInput)
    await user.type(yearInput, '1998')
    await user.click(screen.getByRole('button', { name: 'Save date' }))

    expect(screen.getByText('Around 1998')).toBeInTheDocument()
  })
})
