import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { PanoramaMoment } from '../memories/shared'
import { JournalPage } from './JournalPage'

vi.mock('../auth', () => ({
  useAuth: () => ({ user: { id: 'journal-test-user' } }),
}))

const testNow = new Date(2026, 7, 26, 12)

function createSharedMoment(
  id: string,
  createdAt: Date,
): PanoramaMoment {
  return {
    id,
    blob: new Blob(['panorama'], { type: 'image/jpeg' }),
    objectUrl: `blob:${id}`,
    label: 'Balcony laughter',
    caption: 'Everyone made it.',
    createdAt: createdAt.toISOString(),
    width: 4000,
    height: 2000,
    source: 'manual',
    uploaderDisplayName: 'Maya Ahmed',
  }
}

function renderJournalPage(sharedMoments: PanoramaMoment[] = []) {
  return render(
    <MemoryRouter>
      <JournalPage now={testNow} sharedMoments={sharedMoments} />
    </MemoryRouter>,
  )
}

function MemoryRouteState() {
  const location = useLocation()
  const state = location.state as {
    returnTo?: string
    sourceMemoryId?: string
    journalContext?: {
      selectedDayKey?: string
      view?: string
      focusMemoryId?: string
    }
  } | null

  return (
    <div>
      <span>Return to {state?.returnTo}</span>
      <span>Source memory {state?.sourceMemoryId}</span>
      <span>Selected day {state?.journalContext?.selectedDayKey}</span>
      <span>Selected view {state?.journalContext?.view}</span>
      <span>Focus memory {state?.journalContext?.focusMemoryId}</span>
    </div>
  )
}

describe('JournalPage', () => {
  it('opens on today with a clean three-column photo archive', () => {
    const { container } = renderJournalPage()

    expect(screen.getByRole('heading', { name: 'Memory Journal' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Back to Memories' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Wednesday, August 26, 8 memories' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('heading', { name: 'Wednesday, August 26' })).toBeInTheDocument()
    expect(screen.getByText('8 memories')).toBeInTheDocument()
    expect(container.querySelectorAll('.journal-memories article')).toHaveLength(8)
    const memoryGrid = container.querySelector('.journal-memories')
    expect(memoryGrid).toHaveAttribute('data-layout', 'grid')
    expect(memoryGrid?.children).toHaveLength(8)
    expect(memoryGrid).toHaveClass('journal-memories')
    expect(memoryGrid).not.toHaveClass('journal-memories--list')
    expect(container.querySelector('.journal-memory__meta')).not.toBeInTheDocument()
    expect(container.querySelector('.journal-memory__avatar')).not.toBeInTheDocument()
    expect(container.querySelector('.journal-memory__scrim')).not.toBeInTheDocument()
    expect(screen.queryByText('Mountain day at golden hour')).not.toBeInTheDocument()
    expect(screen.queryByText('Hishaam')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Memory layout' })).not.toBeInTheDocument()
    const contactSheetImages = Array.from(
      container.querySelectorAll<HTMLImageElement>(
        'img[src="/assets/journal/family-memory-grid-v1.png"]',
      ),
    )
    expect(contactSheetImages).toHaveLength(8)
    expect(
      new Set(
        contactSheetImages.map(
          (image) =>
            `${image.style.getPropertyValue('--journal-sheet-x')}:${image.style.getPropertyValue('--journal-sheet-y')}`,
        ),
      ).size,
    ).toBe(8)
    expect(
      container.querySelector(
        'img[src="/assets/design/kinsphere-ui-reference.png"]',
      ),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('link', {
        name: 'Open Mountain day at golden hour, shared by Hishaam, panorama memory',
      }),
    ).toHaveAttribute('href', '/memory/mountains')
    expect(
      screen.queryByRole('button', { name: /create recap/i }),
    ).not.toBeInTheDocument()
    const page = container.querySelector('.journal-page')
    const events = container.querySelector('.journal-events')
    const week = container.querySelector('.journal-week')
    expect(page).not.toBeNull()
    expect(events).not.toBeNull()
    expect(week).not.toBeNull()
    expect(Array.from(page?.children ?? []).indexOf(events as Element)).toBeLessThan(
      Array.from(page?.children ?? []).indexOf(week as Element),
    )
  })

  it('browses archived dates while keeping the fixed photo grid', async () => {
    const user = userEvent.setup()
    const { container } = renderJournalPage()

    await user.click(screen.getByRole('button', { name: 'Sunday, August 23, 3 memories' }))

    expect(screen.getByRole('heading', { name: 'Sunday, August 23' })).toBeInTheDocument()
    expect(screen.getByText('3 memories')).toBeInTheDocument()
    expect(container.querySelectorAll('.journal-memories article')).toHaveLength(3)
    expect(container.querySelector('.journal-memories')).toHaveAttribute('data-layout', 'grid')
    expect(screen.queryByRole('group', { name: 'Memory layout' })).not.toBeInTheDocument()
  })

  it('keeps future days blank and does not offer a recap', async () => {
    const user = userEvent.setup()
    const futureMoment = createSharedMoment(
      'future-balcony',
      new Date(2026, 7, 27, 10),
    )
    const { container } = renderJournalPage([futureMoment])

    await user.click(
      screen.getByRole('button', {
        name: 'Thursday, August 27, 0 memories',
      }),
    )

    expect(
      screen.getByRole('heading', { name: 'Thursday, August 27' }),
    ).toBeInTheDocument()
    expect(screen.getByText('0 memories')).toBeInTheDocument()
    expect(container.querySelector('.journal-memories')).toBeEmptyDOMElement()
    expect(container.querySelectorAll('.journal-memories article')).toHaveLength(0)
    expect(
      screen.queryByRole('button', { name: /create recap/i }),
    ).not.toBeInTheDocument()
    expect(screen.getByText(
      'Moments from this day will appear here after they’re shared.',
    )).toHaveAttribute('role', 'status')
  })

  it('does not offer recaps for archived days before today', async () => {
    const user = userEvent.setup()
    const { container } = renderJournalPage()

    await user.click(
      screen.getByRole('button', {
        name: 'Tuesday, August 25, 5 memories',
      }),
    )

    expect(container.querySelectorAll('.journal-memories article')).toHaveLength(5)
    expect(
      screen.queryByRole('button', { name: /create recap/i }),
    ).not.toBeInTheDocument()
  })

  it('archives uploaded moments on the local day they were created', async () => {
    const user = userEvent.setup()
    const yesterdayMoment = createSharedMoment(
      'family-balcony',
      new Date(2026, 7, 25, 18),
    )
    const { container } = renderJournalPage([yesterdayMoment])

    expect(
      screen.queryByRole('link', {
        name: /open balcony laughter, shared by maya ahmed/i,
      }),
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', {
        name: 'Tuesday, August 25, 6 memories',
      }),
    )

    expect(
      screen.getByRole('link', {
        name: 'Open Balcony laughter, shared by Maya Ahmed, panorama memory',
      }),
    ).toHaveAttribute('href', '/memory/shared-family-balcony')
    expect(container.querySelectorAll('.journal-memories article')).toHaveLength(6)
  })

  it('builds the visible week around the supplied local date', () => {
    render(
      <MemoryRouter>
        <JournalPage now={new Date(2027, 0, 1, 12)} />
      </MemoryRouter>,
    )

    expect(
      screen.getByRole('button', {
        name: 'Friday, January 1, 8 memories',
      }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('button', {
        name: 'Tuesday, December 29, 3 memories',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Monday, January 4, 0 memories',
      }),
    ).toBeInTheDocument()
  })

  it('opens a panorama with enough state to return to the journal', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/journal']}>
        <Routes>
          <Route path="/journal" element={<JournalPage now={testNow} />} />
          <Route path="/memory/:memoryId" element={<MemoryRouteState />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(
      screen.getByRole('link', {
        name: 'Open Mountain day at golden hour, shared by Hishaam, panorama memory',
      }),
    )

    expect(screen.getByText('Return to /journal')).toBeInTheDocument()
    expect(screen.getByText('Source memory mountains')).toBeInTheDocument()
    expect(screen.getByText('Selected day wed-26')).toBeInTheDocument()
    expect(screen.getByText('Selected view grid')).toBeInTheDocument()
    expect(screen.getByText('Focus memory golden-hour')).toBeInTheDocument()
  })

  it('restores its selected day while ignoring a legacy list-layout preference', () => {
    const { container } = render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/journal',
            state: {
              journalContext: {
                selectedDayKey: 'sun-23',
                view: 'list',
                scrollTop: 120,
                focusMemoryId: 'park-picnic',
              },
            },
          },
        ]}
      >
        <JournalPage now={testNow} />
      </MemoryRouter>,
    )

    expect(
      screen.getByRole('button', {
        name: 'Sunday, August 23, 3 memories',
      }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(container.querySelector('.journal-memories')).toHaveAttribute(
      'data-layout',
      'grid',
    )
    expect(screen.queryByRole('button', { name: 'List view' })).not.toBeInTheDocument()
  })
})
