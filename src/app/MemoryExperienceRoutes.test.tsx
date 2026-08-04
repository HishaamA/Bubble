import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { SharedMomentsContext } from '../features/memories/shared/context'
import type { PanoramaMoment } from '../features/memories/shared'
import { JournalRoute } from './MemoryExperienceRoutes'

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

describe('JournalRoute', () => {
  it('reads uploaded moments from the shared Moments context', () => {
    render(
      <SharedMomentsContext.Provider
        value={{
          loading: false,
          error: null,
          moments: [uploadedMoment],
          saveMoment: vi.fn(),
          refresh: vi.fn(),
        }}
      >
        <MemoryRouter>
          <JournalRoute now={new Date(2026, 7, 26, 12)} />
        </MemoryRouter>
      </SharedMomentsContext.Provider>,
    )

    expect(
      screen.getByRole('link', {
        name: 'Open Balcony laughter, shared by Maya, panorama memory',
      }),
    ).toHaveAttribute('href', '/memory/shared-route-balcony')
    expect(
      screen.getByRole('button', {
        name: 'Wednesday, August 26, 9 memories',
      }),
    ).toHaveAttribute('aria-pressed', 'true')
  })
})
