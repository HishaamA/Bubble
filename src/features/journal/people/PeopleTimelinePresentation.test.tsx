import { createRef } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { PeopleTimelineDateEditor, PeopleTimelinePhotoTags } from './PeopleTimelinePhotoDetails'
import { PeopleTimelineScanStatus } from './PeopleTimelineScanStatus'
import { PeopleTimelineViewer } from './PeopleTimelineViewer'
import type { PeopleTimelinePhoto } from './types'

const photo: PeopleTimelinePhoto = {
  key: 'photo:shared/upload',
  id: 'shared/upload',
  kind: 'capsule-photo',
  source: '/small.jpg',
  scanSource: '/original.jpg',
  displayWidth: 1200,
  displayHeight: 800,
  capturedAt: '2024-02-03T12:00:00Z',
  caption: 'Afternoon together',
  contributorName: 'Mum',
  capsuleId: 'family/week',
  memoryId: 'capsule-family/week-shared/upload',
  canScanFaces: true,
}

function viewerProps() {
  return {
    photo,
    layout: 'album' as const,
    personId: 'review-uploads',
    personName: 'All photos',
    position: { index: 0, total: 3 },
    photoLinkRef: createRef<HTMLAnchorElement>(),
    photoFigureRef: createRef<HTMLElement>(),
    onReview: vi.fn(),
    onPositionChange: vi.fn(),
    onEditDate: vi.fn(),
  }
}

function LocationState() {
  const location = useLocation()
  return <output data-testid="location">{JSON.stringify({ path: location.pathname, state: location.state })}</output>
}

describe('controlled timeline photo presentation', () => {
  it('keeps the ordinary photo focus target and metadata editors inside the original viewer DOM', () => {
    const props = viewerProps()
    const { container } = render(
      <MemoryRouter>
        <PeopleTimelineViewer {...props}><div data-testid="editor">Editor</div></PeopleTimelineViewer>
      </MemoryRouter>,
    )
    const figure = screen.getByRole('figure')
    expect(props.photoFigureRef.current).toBe(figure)
    expect(props.photoLinkRef.current).toBeNull()
    expect(figure).toHaveClass('people-timeline__album-photo')
    expect(figure).toHaveAttribute('tabindex', '-1')
    expect(container.querySelector('img')).toHaveAttribute('src', '/original.jpg')
    expect(container.querySelector('.people-timeline__viewer')).toHaveAttribute('data-layout', 'album')
    expect(container.querySelector('.people-timeline__scrubber')?.nextElementSibling).toBe(screen.getByTestId('editor'))
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('keeps scrapbook layers and corrected date copy without moving focus ownership', () => {
    const props = viewerProps()
    const { container } = render(
      <MemoryRouter>
        <PeopleTimelineViewer {...props} layout="scrapbook" dateOverride={{ precision: 'year', value: '1998' }} />
      </MemoryRouter>,
    )
    expect(props.photoFigureRef.current).toHaveClass('people-timeline__scrapbook-photo')
    expect(container.querySelector('.people-timeline__scrapbook-tape')).not.toBeNull()
    expect(container.querySelector('figcaption')).toHaveTextContent('Around 1998')
    expect(container.querySelector('time')).toHaveAttribute('datetime', '1998')
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '1 of 3, Around 1998')
  })

  it.each(['capsule-photo', 'journal-photo'] as const)(
    'preserves %s review links and canonical return identity', (kind) => {
      const props = viewerProps()
      render(
        <MemoryRouter>
          <PeopleTimelineViewer {...props} layout="review" photo={{ ...photo, kind }} />
          <LocationState />
        </MemoryRouter>,
      )
      const link = screen.getByRole('link')
      expect(props.photoLinkRef.current).toBe(link)
      expect(props.photoFigureRef.current).toBeNull()
      const expectedPath = kind === 'journal-photo'
        ? '/journal/library/shared%2Fupload'
        : '/journal/photo/family%2Fweek/shared%2Fupload'
      expect(link).toHaveAttribute('href', expectedPath)
      fireEvent.click(link)
      expect(JSON.parse(screen.getByTestId('location').textContent ?? '')).toEqual({
        path: expectedPath,
        state: {
          returnTo: '/journal', sourceMemoryId: photo.id,
          journalContext: {
            section: 'people', personId: props.personId,
            focusMemoryId: photo.memoryId, focusPhotoKey: photo.key,
          },
        },
      })
    },
  )

  it('delegates manual scrub and edit-date actions without owning a second position', () => {
    const props = viewerProps()
    const { rerender } = render(<MemoryRouter><PeopleTimelineViewer {...props} /></MemoryRouter>)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } })
    expect(props.onPositionChange).toHaveBeenCalledExactlyOnceWith(2)
    expect(screen.getByRole('slider')).toHaveValue('0')
    fireEvent.click(screen.getByRole('button', { name: 'Edit date' }))
    expect(props.onEditDate).toHaveBeenCalledOnce()
    rerender(<MemoryRouter><PeopleTimelineViewer {...props} position={{ index: 0, total: 1 }} /></MemoryRouter>)
    expect(screen.getByRole('slider')).toBeDisabled()
    expect(screen.getByRole('slider')).toHaveAttribute('max', '0')
  })

  it('preserves face outlines and forwards each review decision to its exact suggestion', () => {
    const props = viewerProps()
    const match = { photoKey: photo.key, faceId: 'face', personId: 'mum', confidence: 0.7 }
    const { container } = render(
      <MemoryRouter>
        <PeopleTimelineViewer {...props} layout="review" review={{
          match,
          person: { id: 'mum', name: 'Mum', createdAt: photo.capturedAt },
          face: { id: 'face', box: [0.1, 0.2, 0.3, 0.4], embedding: [], detectorScore: 1, descriptorScore: 1, quality: 1 },
        }} />
      </MemoryRouter>,
    )
    expect(container.querySelector('.people-timeline__face-focus')).toHaveStyle({ left: '10%', top: '20%', width: '30%', height: '40%' })
    for (const label of ['Yes', 'No', 'Not sure']) fireEvent.click(screen.getByRole('button', { name: label }))
    expect(props.onReview.mock.calls).toEqual([[match, 'yes'], [match, 'no'], [match, 'unsure']])
  })
})

describe('controlled photo details', () => {
  it('retains date-input constraints and delegates precision, edits, save, cancel and restore', () => {
    const props = {
      draft: { precision: 'year' as const, value: '2001' }, error: 'Enter a four-digit year.', hasOverride: true,
      onPrecisionChange: vi.fn(), onValueChange: vi.fn(), onSave: vi.fn((event) => event.preventDefault()),
      onCancel: vi.fn(), onRestoreOriginal: vi.fn(),
    }
    const { rerender } = render(<PeopleTimelineDateEditor {...props} />)
    const input = screen.getByRole('spinbutton')
    expect(input).toHaveAttribute('min', '1800')
    expect(input).toHaveAttribute('max', String(new Date().getFullYear() + 1))
    fireEvent.change(input, { target: { value: '2002' } })
    expect(props.onValueChange).toHaveBeenCalledExactlyOnceWith('2002')
    fireEvent.click(screen.getByRole('button', { name: 'Date' }))
    expect(props.onPrecisionChange).toHaveBeenCalledExactlyOnceWith('day')
    fireEvent.submit(screen.getByRole('form', { name: 'Edit photo date' }))
    expect(props.onSave).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use original' }))
    expect(props.onCancel).toHaveBeenCalledOnce()
    expect(props.onRestoreOriginal).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert')).toHaveTextContent(props.error)
    rerender(<PeopleTimelineDateEditor {...props} draft={{ precision: 'day', value: '2001-04-03' }} hasOverride={false} error="" />)
    expect(screen.getByLabelText('Date')).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('Date')).toHaveAttribute('min', '1800-01-01')
    expect(screen.queryByRole('button', { name: 'Use original' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps tag origins photo-specific and delegates changes without mutating assignments', () => {
    const props = {
      photoKey: photo.key,
      people: ['mum', 'dad'].map((id) => ({ id, name: id, createdAt: photo.capturedAt })),
      assignments: [
        { photoKey: photo.key, personId: 'mum', source: 'manual' as const, confirmedAt: photo.capturedAt },
        { photoKey: 'another-photo', personId: 'dad', source: 'manual' as const, confirmedAt: photo.capturedAt },
      ],
      effectivePersonIds: new Set(['mum', 'dad']), open: true, onToggle: vi.fn(), onTagChange: vi.fn(),
    }
    const { rerender } = render(<PeopleTimelinePhotoTags {...props} />)
    const mum = screen.getByRole('checkbox', { name: /mum/ })
    const dad = screen.getByRole('checkbox', { name: /dad/ })
    expect(mum).toBeChecked()
    expect(dad).toBeChecked()
    expect(mum.closest('label')).toHaveTextContent('Confirmed by you')
    expect(dad.closest('label')).toHaveTextContent('Matched automatically')
    fireEvent.click(mum)
    expect(props.onTagChange).toHaveBeenCalledExactlyOnceWith('mum', false)
    expect(props.assignments).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'People in this photo' }))
    expect(props.onToggle).toHaveBeenCalledOnce()
    rerender(<PeopleTimelinePhotoTags {...props} open={false} />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the no-people guidance inside the expanded tag panel', () => {
    render(<PeopleTimelinePhotoTags photoKey={photo.key} people={[]} assignments={[]} open onToggle={vi.fn()} onTagChange={vi.fn()} />)
    expect(screen.getByText('Add a person with a face photo above, then review or correct matches here.')).toBeInTheDocument()
  })
})

describe('controlled scan privacy status', () => {
  it('honors parent busy guards and keeps scan cancel and clear confirmation independent', () => {
    const props = {
      progress: { completed: 1, total: 3 }, hasPendingPhotos: true, scanDisabled: true, clearDisabled: true,
      clearing: false, confirmingClear: false, message: 'Checking on this device', error: false,
      onScan: vi.fn(), onCancelScan: vi.fn(), onToggleClear: vi.fn(), onClear: vi.fn(), onKeep: vi.fn(),
    }
    const { rerender } = render(<PeopleTimelineScanStatus {...props} />)
    expect(screen.getByRole('button', { name: '1/3' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Clear face data' })).toBeDisabled()
    expect(props.onScan).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancelScan).toHaveBeenCalledOnce()
    rerender(<PeopleTimelineScanStatus {...props} progress={null} scanDisabled={false} clearDisabled={false} confirmingClear error />)
    fireEvent.click(screen.getByRole('button', { name: 'Check new photos' }))
    expect(props.onScan).toHaveBeenCalledOnce()
    const confirmation = screen.getByRole('group', { name: 'Confirm clear face data' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Clear' }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Keep' }))
    expect(props.onClear).toHaveBeenCalledOnce()
    expect(props.onKeep).toHaveBeenCalledOnce()
    expect(screen.getByRole('status')).toHaveAttribute('data-error', 'true')
  })
})
