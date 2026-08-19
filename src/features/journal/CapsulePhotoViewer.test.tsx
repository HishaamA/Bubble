import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { FamilyCapsule } from '../capsules/types'
import { CapsulePhotoViewer } from './CapsulePhotoViewer'
import type { JournalPhoto } from './journalPhotoTypes'

function capsule(
  opensAt = '2026-08-28T00:00:00.000Z',
  includeAdjacentPhoto = false,
): FamilyCapsule {
  return {
    id: 'family-week',
    kind: 'weekly',
    title: 'Our little week',
    createdAt: '2026-08-24T00:00:00.000Z',
    closesAt: '2026-08-27T23:59:59.000Z',
    opensAt,
    weekStart: '2026-08-24',
    createdByName: 'Simreen',
    photos: [
      {
        id: 'garden-photo',
        capsuleId: 'family-week',
        image: '/garden-full.jpg',
        thumbnail: '/garden-thumb.jpg',
        width: 1200,
        height: 1600,
        caption: 'Watering grandpa’s roses',
        capturedAt: '2026-08-27T16:30:00.000Z',
        contributorName: 'Maya Ahmed',
        ownedByCurrentUser: false,
        syncStatus: 'synced',
      },
      ...(includeAdjacentPhoto ? [{
        id: 'patio-photo',
        capsuleId: 'family-week',
        image: '/patio-full.jpg',
        thumbnail: '/patio-thumb.jpg',
        width: 1200,
        height: 1600,
        caption: 'Tea on the patio',
        capturedAt: '2026-08-27T18:30:00.000Z',
        contributorName: 'Simreen Ahmed',
        ownedByCurrentUser: false,
        syncStatus: 'synced' as const,
      }] : []),
    ],
  }
}

function JournalStateProbe() {
  const location = useLocation()
  const state = location.state as {
    journalContext?: {
      selectedDayKey?: string
      focusMemoryId?: string
      weekOffset?: number
    }
  } | null

  return (
    <div>
      <span>Journal route</span>
      <span>Selected {state?.journalContext?.selectedDayKey}</span>
      <span>Focus {state?.journalContext?.focusMemoryId}</span>
      <span>Week offset {state?.journalContext?.weekOffset}</span>
    </div>
  )
}

function renderViewer(opensAt?: string, includeAdjacentPhoto = false) {
  return render(
    <MemoryRouter
      initialEntries={[{
        pathname: '/journal/photo/family-week/garden-photo',
        state: {
          returnTo: '/journal',
          journalContext: {
            selectedDayKey: 'thu-27',
            view: 'grid',
            scrollTop: 220,
            focusMemoryId: 'capsule-family-week-garden-photo',
            weekOffset: -1,
          },
        },
      }]}
    >
      <Routes>
        <Route
          path="/journal/photo/:capsuleId/:photoId"
          element={(
            <CapsulePhotoViewer
              capsules={[capsule(opensAt, includeAdjacentPhoto)]}
              now={new Date('2026-08-29T12:00:00.000Z')}
            />
          )}
        />
        <Route path="/journal" element={<JournalStateProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('CapsulePhotoViewer', () => {
  it('shows an unlocked Capsule photo as a normal family feed post', () => {
    renderViewer()

    expect(screen.getByRole('heading', { name: 'Photo memory' })).toBeInTheDocument()
    expect(screen.getByText('Our little week')).toBeInTheDocument()
    expect(screen.getAllByText('Maya Ahmed')).toHaveLength(2)
    expect(screen.getByText(/watering grandpa’s roses/i)).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: 'Watering grandpa’s roses' }),
    ).toHaveAttribute('src', '/garden-full.jpg')
    expect(screen.getByText('1 of 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it.each([
    ['back control', 'Back to Journal'],
    ['close control', 'Close photo and return to Journal'],
  ])('returns to the same Journal context through the %s', async (_label, controlName) => {
    const user = userEvent.setup()
    renderViewer()

    await user.click(screen.getByRole('button', { name: controlName }))

    expect(screen.getByText('Journal route')).toBeInTheDocument()
    expect(screen.getByText('Selected thu-27')).toBeInTheDocument()
    expect(
      screen.getByText('Focus capsule-family-week-garden-photo'),
    ).toBeInTheDocument()
    expect(screen.getByText('Week offset -1')).toBeInTheDocument()
  })

  it('returns focus context for the photo currently shown after paging', async () => {
    const user = userEvent.setup()
    renderViewer(undefined, true)

    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(
      screen.getByRole('img', { name: 'Tea on the patio' }),
    ).toHaveAttribute('src', '/patio-full.jpg')
    await user.click(screen.getByRole('button', { name: 'Back to Journal' }))

    expect(screen.getByText('Journal route')).toBeInTheDocument()
    expect(
      screen.getByText('Focus capsule-family-week-patio-photo'),
    ).toBeInTheDocument()
  })

  it('does not expose a direct-linked photo before its real unlock time', () => {
    renderViewer('2026-09-01T00:00:00.000Z')

    expect(
      screen.getByRole('heading', {
        name: 'This photo is still sealed or unavailable.',
      }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to Journal' })).toBeInTheDocument()
  })

  it('opens a direct Journal-library photo without Capsule semantics', () => {
    const directPhoto: JournalPhoto = {
      id: 'direct-photo',
      image: '/direct-full.jpg',
      thumbnail: '/direct-thumb.jpg',
      width: 1200,
      height: 900,
      caption: 'First day of school',
      capturedAt: '2012-09-03T08:00:00.000Z',
      contributorName: 'Maya Ahmed',
      ownedByCurrentUser: true,
      syncStatus: 'pending',
    }
    render(
      <MemoryRouter initialEntries={['/journal/library/direct-photo']}>
        <Routes>
          <Route
            path="/journal/library/:photoId"
            element={(
              <CapsulePhotoViewer
                capsules={[]}
                journalPhotos={[directPhoto]}
                now={new Date('2026-08-29T12:00:00.000Z')}
              />
            )}
          />
        </Routes>
      </MemoryRouter>,
    )

    expect(
      screen.getByRole('img', { name: 'First day of school' }),
    ).toHaveAttribute('src', '/direct-full.jpg')
    expect(screen.getAllByText('Family photos')).not.toHaveLength(0)
    expect(screen.getByText(/added to/i)).toBeInTheDocument()
    expect(screen.queryByText(/opened from/i)).not.toBeInTheDocument()
  })
})
