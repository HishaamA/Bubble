import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FamilyCapsule } from '../capsules/types'
import type { JournalPhoto } from './journalPhotoTypes'
import { JournalPage } from './JournalPage'

const sectionMocks = vi.hoisted(() => ({
  people: vi.fn(),
  plans: vi.fn(),
  flights: vi.fn(),
}))

vi.mock('./people', () => ({
  PeopleTimeline: (props: unknown) => {
    sectionMocks.people(props)
    const callbacks = props as { onClosePersonAlbum?: () => void }
    return (
      <section data-testid="people-section">
        People timeline
        {callbacks.onClosePersonAlbum ? (
          <button type="button" onClick={callbacks.onClosePersonAlbum}>
            Close scrapbook
          </button>
        ) : null}
      </section>
    )
  },
}))

vi.mock('../events', () => ({
  JournalEventsSection: () => {
    sectionMocks.plans()
    return <section data-testid="plans-section">Important plans</section>
  },
}))

vi.mock('../flights', () => ({
  FlightTrackerSection: (props: unknown) => {
    sectionMocks.flights(props)
    return <section data-testid="flights-section">Family flights</section>
  },
}))

const testNow = new Date(2026, 7, 26, 12)

function createCapsule({
  id,
  opensAt,
  capturedAt,
}: {
  id: string
  opensAt: Date
  capturedAt: Date
}): FamilyCapsule {
  return {
    id,
    kind: 'weekly',
    title: `Family week ${id}`,
    createdAt: new Date(2026, 7, 17, 9).toISOString(),
    closesAt: opensAt.toISOString(),
    opensAt: opensAt.toISOString(),
    weekStart: '2026-08-17',
    createdByName: 'Maya',
    photos: [
      {
        id: `${id}-photo`,
        capsuleId: id,
        image: `/assets/capsule/${id}.jpg`,
        thumbnail: `/assets/capsule/${id}-thumb.jpg`,
        width: 1200,
        height: 900,
        thumbnailWidth: 400,
        thumbnailHeight: 300,
        caption: 'Kitchen dancing',
        capturedAt: capturedAt.toISOString(),
        contributorName: 'Maya',
        ownedByCurrentUser: false,
        syncStatus: 'synced',
      },
    ],
  }
}

function renderJournal(
  props: ComponentProps<typeof JournalPage> = {},
  initialEntry: string | {
    pathname: string
    state?: unknown
  } = '/journal',
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <JournalPage now={testNow} {...props} />
    </MemoryRouter>,
  )
}

describe('JournalPage', () => {
  beforeEach(() => {
    sectionMocks.people.mockClear()
    sectionMocks.plans.mockClear()
    sectionMocks.flights.mockClear()
  })

  it('shows the reference three-section Journal with Photos selected by default', () => {
    const { container } = renderJournal()

    expect(screen.getByRole('heading', { name: 'Journal' })).toBeInTheDocument()
    expect(screen.getByText('Our family')).toBeInTheDocument()
    expect(screen.getByText('Your private place to remember.')).toBeInTheDocument()

    const tablist = screen.getByRole('tablist', { name: 'Journal sections' })
    expect(tablist).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(screen.getByRole('tab', { name: 'Photos' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByTestId('people-section')).toBeInTheDocument()
    expect(screen.queryByTestId('plans-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('flights-section')).not.toBeInTheDocument()

    expect(screen.queryByText('Mountain day at golden hour')).not.toBeInTheDocument()
    expect(screen.queryByText('Dinner that lasted all evening')).not.toBeInTheDocument()
    expect(container.querySelector('.journal-week')).not.toBeInTheDocument()
  })

  it('mounts only the selected People, Plans, or Flights section', async () => {
    const user = userEvent.setup()
    renderJournal()

    await user.click(screen.getByRole('tab', { name: 'Plans' }))

    expect(screen.queryByTestId('people-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('plans-section')).toBeInTheDocument()
    expect(screen.queryByTestId('flights-section')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Plans' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('heading', { name: 'Journal' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Flights' }))

    expect(screen.queryByTestId('people-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plans-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('flights-section')).toBeInTheDocument()
    expect(sectionMocks.people).toHaveBeenCalledTimes(1)
    expect(sectionMocks.plans).toHaveBeenCalledTimes(1)
    expect(sectionMocks.flights).toHaveBeenCalledTimes(1)
    expect(sectionMocks.flights).toHaveBeenLastCalledWith({ now: testNow })
  })

  it('supports arrow-key navigation across the segmented tabs', async () => {
    const user = userEvent.setup()
    renderJournal()

    const peopleTab = screen.getByRole('tab', { name: 'Photos' })
    peopleTab.focus()
    await user.keyboard('{ArrowRight}')

    const plansTab = screen.getByRole('tab', { name: 'Plans' })
    expect(plansTab).toHaveFocus()
    expect(plansTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('plans-section')).toBeInTheDocument()
  })

  it('passes only opened Capsule photos to People', () => {
    const openedCapsule = createCapsule({
      id: 'opened',
      opensAt: new Date(2026, 7, 26, 11),
      capturedAt: new Date(2001, 4, 12, 9),
    })
    const lockedCapsule = createCapsule({
      id: 'locked',
      opensAt: new Date(2026, 7, 26, 13),
      capturedAt: new Date(2002, 5, 13, 9),
    })
    const directPhoto: JournalPhoto = {
      id: 'direct-photo',
      image: '/assets/direct.jpg',
      thumbnail: '/assets/direct-thumb.jpg',
      width: 1200,
      height: 900,
      caption: 'Direct upload',
      capturedAt: new Date(2000, 3, 11, 9).toISOString(),
      contributorName: 'Maya',
      ownedByCurrentUser: true,
      syncStatus: 'pending',
    }
    const onUploadJournalPhotos = vi.fn(async () => ({ added: 1, failed: 0 }))
    renderJournal({
      capsules: [lockedCapsule, openedCapsule],
      capsuleNow: testNow,
      capsuleCacheNamespace: 'family:ahmed',
      journalPhotos: [directPhoto],
      onUploadJournalPhotos,
      journalPhotoImportProgress: { importing: false, completed: 0, total: 0 },
    })

    const peopleProps = sectionMocks.people.mock.lastCall?.[0] as {
      photos: Array<{
        id: string
        capsuleId: string
        capsuleTitle: string
      }>
      cacheNamespace: string
      journalPhotos: JournalPhoto[]
      onUploadPhotos: unknown
    }

    expect(peopleProps.photos).toEqual([
      expect.objectContaining({
        id: 'opened-photo',
        capsuleId: 'opened',
        capsuleTitle: 'Family week opened',
      }),
    ])
    expect(peopleProps).not.toHaveProperty('sharedMoments')
    expect(peopleProps.journalPhotos).toEqual([directPhoto])
    expect(peopleProps.onUploadPhotos).toBe(onUploadJournalPhotos)
    expect(peopleProps.cacheNamespace).toBe('family:ahmed')
  })

  it('keeps the original People default when preview content is enabled', () => {
    renderJournal({ openAllPhotosByDefault: true })

    expect(sectionMocks.people).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialPersonId: undefined,
      }),
    )
  })

  it('returns directly to the section recorded in journalContext', () => {
    renderJournal(
      {},
      {
        pathname: '/journal',
        state: {
          journalContext: {
            section: 'flights',
            personId: 'maya',
          },
        },
      },
    )

    expect(screen.getByRole('tab', { name: 'Flights' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByTestId('flights-section')).toBeInTheDocument()
    expect(screen.queryByTestId('people-section')).not.toBeInTheDocument()
    expect(sectionMocks.people).not.toHaveBeenCalled()
  })

  it('restores the selected person and focused memory after opening a photo', () => {
    renderJournal(
      { openAllPhotosByDefault: true },
      {
        pathname: '/journal',
        state: {
          journalContext: {
            section: 'people',
            personId: 'maya',
            focusMemoryId: 'capsule-opened-opened-photo',
          },
        },
      },
    )

    expect(sectionMocks.people).toHaveBeenLastCalledWith(expect.objectContaining({
      initialPersonId: 'maya',
      focusMemoryId: 'capsule-opened-opened-photo',
    }))
  })

  it('opens a recognized person as a dedicated scrapbook page', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/journal/person/maya']}>
        <Routes>
          <Route
            path="/journal/person/:personId"
            element={<JournalPage now={testNow} capsuleCacheNamespace="family:ahmed" />}
          />
          <Route path="/journal" element={<p>Journal home</p>} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.queryByRole('heading', { name: 'Journal' })).not.toBeInTheDocument()
    expect(screen.getByTestId('people-section')).toBeInTheDocument()
    expect(sectionMocks.people).toHaveBeenLastCalledWith(expect.objectContaining({
      initialPersonId: 'maya',
      personAlbumOpen: true,
      onOpenPersonAlbum: expect.any(Function),
      onClosePersonAlbum: expect.any(Function),
    }))

    await user.click(screen.getByRole('button', { name: 'Close scrapbook' }))
    expect(screen.getByText('Journal home')).toBeInTheDocument()
  })
})
