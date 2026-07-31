import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanoramaScene } from '../../viewer'
import { MemoryConstellation } from './MemoryConstellation'
import { PanoramaMemoryScreen } from './PanoramaMemoryScreen'

vi.mock('../../viewer', () => ({
  PanoramaViewer: ({ scenes }: { scenes: readonly PanoramaScene[] }) => (
    <button
      type="button"
      data-panorama={scenes[0]?.panorama}
      onClick={() =>
        scenes[0]?.hotSpots?.[0]?.onActivate?.(new MouseEvent('click'))
      }
    >
      Trigger voice hotspot
    </button>
  ),
}))

const cancelSpeech = vi.fn()
const speak = vi.fn()

class SpeechSynthesisUtteranceMock {
  pitch = 1
  rate = 1
  readonly text: string

  constructor(text: string) {
    this.text = text
  }
}

describe('PanoramaMemoryScreen lifecycle', () => {
  beforeEach(() => {
    cancelSpeech.mockClear()
    speak.mockClear()
    vi.stubGlobal('SpeechSynthesisUtterance', SpeechSynthesisUtteranceMock)
    vi.stubGlobal('speechSynthesis', {
      cancel: cancelSpeech,
      speak,
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('focuses the memory title and restores the originating bubble on back', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/memory/dinner']}>
        <Routes>
          <Route path="/" element={<MemoryConstellation />} />
          <Route path="/memory/:memoryId" element={<PanoramaMemoryScreen />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Sunday dinner' }),
      ).toHaveFocus(),
    )

    await user.click(screen.getByRole('button', { name: 'Back to memories' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /open sunday dinner memory/i }),
      ).toHaveFocus(),
    )
  })

  it('stops speech when dismissed and when the viewer unmounts', async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <MemoryRouter initialEntries={['/memory/dinner']}>
        <Routes>
          <Route path="/memory/:memoryId" element={<PanoramaMemoryScreen />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole('button', { name: 'Trigger voice hotspot' }))
    expect(speak).toHaveBeenCalledOnce()
    expect(screen.getByText(/everyone talking, everyone laughing/i)).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Dismiss voice note' }))
    expect(screen.queryByText(/everyone talking, everyone laughing/i)).not.toBeInTheDocument()
    expect(cancelSpeech).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: 'Trigger voice hotspot' }))
    unmount()
    expect(cancelSpeech).toHaveBeenCalledTimes(4)
  })

  it('opens a received family upload as the actual panorama scene', async () => {
    render(
      <MemoryRouter initialEntries={['/memory/shared-family-balcony']}>
        <Routes>
          <Route
            path="/memory/:memoryId"
            element={
              <PanoramaMemoryScreen
                sharedMoments={[
                  {
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
                  },
                ]}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    )

    expect(
      await screen.findByRole('heading', { name: 'Family balcony' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Trigger voice hotspot' }),
    ).toHaveAttribute('data-panorama', 'blob:family-balcony')
  })
})
