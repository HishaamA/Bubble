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
      data-scene-title={scenes[0]?.title}
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

  it('returns a journal memory to the journal', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/memory/sunset',
            state: { returnTo: '/journal', sourceMemoryId: 'sunset' },
          },
        ]}
      >
        <Routes>
          <Route path="/journal" element={<p>Memory journal</p>} />
          <Route path="/memory/:memoryId" element={<PanoramaMemoryScreen />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole('button', { name: 'Back to journal' }))

    expect(screen.getByText('Memory journal')).toBeInTheDocument()
  })

  it('opens the memory chooser before making any VR permission request', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/memory/dinner',
            state: { openVr: true, sourceMemoryId: 'dinner' },
          },
        ]}
      >
        <Routes>
          <Route path="/memory/:memoryId" element={<PanoramaMemoryScreen />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(
      await screen.findByRole('heading', {
        name: 'Choose a moment',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Close VR setup' }),
    ).toHaveFocus()
    expect(
      document.querySelector('.ks-cardboard--active'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      /cardboard setup opened/i,
    )
  })

  it('uses the chosen memory for both Cardboard eyes after the Go gesture', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/memory/dinner']}>
        <Routes>
          <Route path="/memory/:memoryId" element={<PanoramaMemoryScreen />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(document.querySelectorAll('[data-panorama]')).toHaveLength(1)
    await user.click(
      screen.getByRole('button', { name: 'Set up Cardboard VR view' }),
    )
    await user.click(
      screen.getByRole('radio', { name: /beach day, hishaam/i }),
    )
    await user.click(
      screen.getByRole('button', { name: 'Continue with Beach day' }),
    )
    expect(
      screen.getByRole('heading', { name: 'Turn your phone sideways' }),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(
      screen.getByRole('heading', { name: 'Place your phone in Cardboard' }),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Go' }))

    await waitFor(() => {
      expect(
        document.querySelector('.ks-cardboard--active'),
      ).toBeInTheDocument()
      expect(document.querySelectorAll('[data-panorama]')).toHaveLength(2)
      document.querySelectorAll('[data-panorama]').forEach((viewport) => {
        expect(viewport).toHaveAttribute(
          'data-panorama',
          '/assets/panoramas/jordan-pond-demo.jpg',
        )
        expect(viewport).toHaveAttribute('data-scene-title', 'Beach day')
      })
    })
  })

  it('offers current shared uploads and keeps static fixture memories available', async () => {
    const user = userEvent.setup()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)

    render(
      <MemoryRouter initialEntries={['/memory/dinner']}>
        <Routes>
          <Route
            path="/memory/:memoryId"
            element={
              <PanoramaMemoryScreen
                sharedMoments={[
                  {
                    id: 'today',
                    blob: new Blob(['today'], { type: 'image/jpeg' }),
                    objectUrl: 'blob:today',
                    label: 'Today together',
                    caption: '',
                    createdAt: new Date().toISOString(),
                    width: 4000,
                    height: 2000,
                    source: 'manual',
                    uploaderDisplayName: 'Maya',
                  },
                  {
                    id: 'yesterday',
                    blob: new Blob(['yesterday'], { type: 'image/jpeg' }),
                    objectUrl: 'blob:yesterday',
                    label: 'Yesterday together',
                    caption: '',
                    createdAt: yesterday.toISOString(),
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

    await user.click(
      screen.getByRole('button', { name: 'Set up Cardboard VR view' }),
    )

    expect(screen.getByText('Available memories')).toBeVisible()
    expect(
      screen.getByRole('radio', { name: 'Today together, Maya' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('radio', { name: 'Yesterday together, Maya' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: /beach day, hishaam/i }),
    ).toBeVisible()
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
    const user = userEvent.setup()
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
                    createdAt: new Date().toISOString(),
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

    await user.click(
      screen.getByRole('button', { name: 'Set up Cardboard VR view' }),
    )
    expect(
      screen.getByRole('radio', { name: 'Family balcony, Maya' }),
    ).toHaveAttribute('aria-checked', 'true')
    await user.click(
      screen.getByRole('button', {
        name: 'Continue with Family balcony',
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Go' }))

    await waitFor(() => {
      const stereoViews = document.querySelectorAll('[data-panorama]')
      expect(stereoViews).toHaveLength(2)
      stereoViews.forEach((viewport) =>
        expect(viewport).toHaveAttribute('data-panorama', 'blob:family-balcony'),
      )
    })
  })
})
