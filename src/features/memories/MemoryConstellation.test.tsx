import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { MemoryConstellation } from './MemoryConstellation'
import type { PanoramaMoment } from './shared'

const sharedMoment: PanoramaMoment = {
  id: 'family-balcony',
  blob: new Blob(['panorama'], { type: 'image/jpeg' }),
  objectUrl: 'blob:family-balcony',
  label: 'Family balcony',
  caption: 'Everyone made it.',
  createdAt: '2026-08-26T10:00:00.000Z',
  width: 4000,
  height: 2000,
  source: 'manual',
  uploaderDisplayName: 'Maya',
}

describe('MemoryConstellation', () => {
  it('exposes the memory bubbles as descriptive controls', () => {
    render(
      <MemoryRouter>
        <MemoryConstellation />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: 'KinSphere' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /open sunday dinner memory/i })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /open .* memory/i })).toHaveLength(10)
  })

  it('opens the selected memory route', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<MemoryConstellation />} />
          <Route path="/memory/:memoryId" element={<p>Panorama opened</p>} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole('button', { name: /open sunday dinner memory/i }))
    expect(screen.getByText('Panorama opened')).toBeInTheDocument()
  })

  it('opens a focused bubble with the keyboard', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<MemoryConstellation />} />
          <Route path="/memory/:memoryId" element={<p>Keyboard panorama opened</p>} />
        </Routes>
      </MemoryRouter>,
    )

    screen.getByRole('button', { name: /open sunday dinner memory/i }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('Keyboard panorama opened')).toBeInTheDocument()
  })

  it('surfaces the newest received 360 as a memory bubble', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <Routes>
          <Route
            path="/"
            element={<MemoryConstellation sharedMoments={[sharedMoment]} />}
          />
          <Route path="/memory/:memoryId" element={<p>Shared panorama opened</p>} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(
      screen.getByRole('button', {
        name: /open family balcony shared by maya/i,
      }),
    )
    expect(screen.getByText('Shared panorama opened')).toBeInTheDocument()
  })

  it('does not open a memory when a thumb gesture becomes a drag', () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<MemoryConstellation />} />
          <Route path="/memory/:memoryId" element={<p>Unexpected panorama</p>} />
        </Routes>
      </MemoryRouter>,
    )

    const field = screen.getByLabelText('Family memory constellation')
    Object.defineProperties(field, {
      clientWidth: { configurable: true, value: 360 },
      clientHeight: { configurable: true, value: 560 },
    })
    vi.spyOn(field, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 360,
      bottom: 560,
      left: 0,
      width: 360,
      height: 560,
      toJSON: () => ({}),
    })

    fireEvent.pointerDown(field, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 110,
      clientY: 180,
    })
    fireEvent.pointerMove(field, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 145,
      clientY: 220,
    })
    fireEvent.pointerUp(field, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 145,
      clientY: 220,
    })
    fireEvent.click(
      screen.getByRole('button', { name: /open sunday dinner memory/i }),
      { detail: 1 },
    )

    expect(screen.queryByText('Unexpected panorama')).not.toBeInTheDocument()
  })

  it('restores focus to the originating memory after returning', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          { pathname: '/', state: { restoreMemoryId: 'dinner' } },
        ]}
      >
        <MemoryConstellation />
      </MemoryRouter>,
    )

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /open sunday dinner memory/i }),
      ).toHaveFocus(),
    )
  })
})
