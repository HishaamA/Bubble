import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanoramaScene } from '../../viewer'
import { MemoryConstellation } from './MemoryConstellation'
import { PanoramaMemoryScreen } from './PanoramaMemoryScreen'

vi.mock('../../viewer', () => ({
  PanoramaViewer: ({
    scenes,
    additionalControls,
    pointSelectionEnabled,
    onPointSelect,
  }: {
    scenes: readonly PanoramaScene[]
    additionalControls?: ReactNode
    pointSelectionEnabled?: boolean
    onPointSelect?: (point: { pitch: number; yaw: number }) => void
  }) => (
    <div>
      <button
        type="button"
        data-panorama={scenes[0]?.panorama}
        data-scene-title={scenes[0]?.title}
        data-hotspot-label={scenes[0]?.hotSpots?.[0]?.label}
        onClick={() =>
          scenes[0]?.hotSpots?.[0]?.onActivate?.(new MouseEvent('click'))
        }
      >
        Trigger voice hotspot
      </button>
      {pointSelectionEnabled ? (
        <button
          type="button"
          onClick={() => onPointSelect?.({ pitch: 14, yaw: -27 })}
        >
          Place saved-scene point
        </button>
      ) : null}
      {additionalControls}
    </div>
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

function MomentsRouteProbe() {
  const location = useLocation()
  const state = location.state as { restoreMemoryId?: string } | null

  return (
    <>
      <h1>Moments bubbles</h1>
      <output aria-label="Restored memory">{state?.restoreMemoryId ?? ''}</output>
    </>
  )
}

function JournalRouteProbe() {
  const location = useLocation()
  const state = location.state as {
    journalContext?: {
      selectedDayKey?: string
      view?: 'grid' | 'list'
      scrollTop?: number
      focusMemoryId?: string
    }
  } | null

  return (
    <>
      <h1>Memory journal</h1>
      <output aria-label="Restored journal day">
        {state?.journalContext?.selectedDayKey ?? ''}
      </output>
      <output aria-label="Restored journal view">
        {state?.journalContext?.view ?? ''}
      </output>
      <output aria-label="Restored journal scroll">
        {state?.journalContext?.scrollTop ?? ''}
      </output>
      <output aria-label="Restored journal memory">
        {state?.journalContext?.focusMemoryId ?? ''}
      </output>
    </>
  )
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
    window.localStorage.removeItem('kinsphere:family-moment-comments:v1')
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
            state: {
              returnTo: '/journal',
              sourceMemoryId: 'sunset',
              journalContext: {
                selectedDayKey: 'sun-23',
                view: 'grid',
                scrollTop: 84,
                focusMemoryId: 'park-picnic',
              },
            },
          },
        ]}
      >
        <Routes>
          <Route path="/journal" element={<JournalRouteProbe />} />
          <Route path="/memory/:memoryId" element={<PanoramaMemoryScreen />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole('button', { name: 'Back to journal' }))

    expect(
      screen.getByRole('heading', { name: 'Memory journal' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Restored journal day')).toHaveTextContent(
      'sun-23',
    )
    expect(screen.getByLabelText('Restored journal view')).toHaveTextContent(
      'grid',
    )
    expect(screen.getByLabelText('Restored journal scroll')).toHaveTextContent(
      '84',
    )
    expect(screen.getByLabelText('Restored journal memory')).toHaveTextContent(
      'park-picnic',
    )
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

  it('skips the chooser and uses the currently viewed memory for Cardboard', async () => {
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
    expect(
      screen.queryByRole('heading', { name: 'Choose a moment' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('radiogroup', {
        name: 'Choose from available memories',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('dialog', {
        name: /turn your phone sideways|place your phone in cardboard/i,
      }),
    ).toBeVisible()
    const landscapeOverride = screen.queryByRole('button', {
      name: 'Use split view anyway',
    })
    if (landscapeOverride) await user.click(landscapeOverride)
    expect(
      screen.getByRole('heading', { name: 'Place your phone in Cardboard' }),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Go' }))

    await waitFor(() => {
      expect(
        document.querySelector('.ks-cardboard--active'),
      ).toBeInTheDocument()
      expect(document.querySelectorAll('[data-panorama]')).toHaveLength(1)
      expect(document.querySelectorAll('.ks-cardboard__reticle')).toHaveLength(2)
      document.querySelectorAll('[data-panorama]').forEach((viewport) => {
        expect(viewport).toHaveAttribute(
          'data-panorama',
          '/assets/panoramas/sunday-dinner-demo.jpg',
        )
        expect(viewport).toHaveAttribute('data-scene-title', 'Sunday dinner')
      })
    })
  })

  it('returns a Journal-opened VR memory to the Journal with its archive context', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/memory/dinner',
            state: {
              returnTo: '/journal',
              journalContext: {
                selectedDayKey: 'wed-26',
                view: 'grid',
                scrollTop: 132,
                focusMemoryId: 'golden-hour',
              },
            },
          },
        ]}
      >
        <Routes>
          <Route path="/" element={<MomentsRouteProbe />} />
          <Route path="/journal" element={<JournalRouteProbe />} />
          <Route path="/memory/:memoryId" element={<PanoramaMemoryScreen />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(
      screen.getByRole('button', { name: 'Set up Cardboard VR view' }),
    )
    const landscapeOverride = screen.queryByRole('button', {
      name: 'Use split view anyway',
    })
    if (landscapeOverride) await user.click(landscapeOverride)
    await user.click(screen.getByRole('button', { name: 'Go' }))
    await user.click(
      await screen.findByRole('button', { name: 'Exit Cardboard view' }),
    )

    expect(
      await screen.findByRole('heading', { name: 'Memory journal' }),
    ).toBeVisible()
    expect(screen.getByLabelText('Restored journal day')).toHaveTextContent(
      'wed-26',
    )
    expect(screen.getByLabelText('Restored journal view')).toHaveTextContent(
      'grid',
    )
    expect(screen.getByLabelText('Restored journal scroll')).toHaveTextContent(
      '132',
    )
    expect(screen.getByLabelText('Restored journal memory')).toHaveTextContent(
      'golden-hour',
    )
  })

  it('keeps a Moments-opened VR exit returning to the viewed bubble', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/memory/dinner']}>
        <Routes>
          <Route path="/" element={<MomentsRouteProbe />} />
          <Route path="/memory/:memoryId" element={<PanoramaMemoryScreen />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(
      screen.getByRole('button', { name: 'Set up Cardboard VR view' }),
    )
    const landscapeOverride = screen.queryByRole('button', {
      name: 'Use split view anyway',
    })
    if (landscapeOverride) await user.click(landscapeOverride)
    await user.click(screen.getByRole('button', { name: 'Go' }))
    await user.click(
      await screen.findByRole('button', { name: 'Exit Cardboard view' }),
    )

    expect(
      await screen.findByRole('heading', { name: 'Moments bubbles' }),
    ).toBeVisible()
    expect(screen.getByLabelText('Restored memory')).toHaveTextContent('dinner')
  })

  it('closes a shortcut-launched VR chooser back to the Moments bubbles', async () => {
    const user = userEvent.setup()
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
          <Route path="/" element={<MomentsRouteProbe />} />
          <Route path="/memory/:memoryId" element={<PanoramaMemoryScreen />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(
      await screen.findByRole('heading', { name: 'Choose a moment' }),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close VR setup' }))

    expect(
      await screen.findByRole('heading', { name: 'Moments bubbles' }),
    ).toBeVisible()
    expect(screen.getByLabelText('Restored memory')).toHaveTextContent('dinner')
  })

  it('never exposes Sunday dinner while an immediately closed Moments VR shortcut restores the bubbles', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MemoryConstellation />} />
          <Route path="/memory/:memoryId" element={<PanoramaMemoryScreen />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(
      screen.getByRole('button', { name: 'Set up Cardboard VR' }),
    )

    expect(
      await screen.findByRole('heading', { name: 'Choose a moment' }),
    ).toBeVisible()
    expect(
      document.querySelector(
        '[data-panorama="/assets/panoramas/sunday-dinner-demo.jpg"]',
      ),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Sunday dinner' }),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close VR setup' }))

    expect(
      await screen.findByRole('heading', { name: 'Moments' }),
    ).toBeVisible()
    expect(
      document.querySelector(
        '[data-panorama="/assets/panoramas/sunday-dinner-demo.jpg"]',
      ),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Sunday dinner' }),
    ).not.toBeInTheDocument()
  })

  it('keeps the homepage VR shortcut chooser populated with current uploads', async () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)

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
                    annotations: [
                      {
                        id: 'jasmine-note',
                        kind: 'text',
                        pitch: 4,
                        yaw: 22,
                        message: 'Grandma planted this jasmine.',
                        audioUrl: null,
                      },
                    ],
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
                    annotations: [
                      {
                        id: 'jasmine-note',
                        kind: 'text',
                        pitch: -8,
                        yaw: 24,
                        message: 'Grandma planted this jasmine.',
                        audioUrl: null,
                      },
                    ],
                  },
                ]}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    )

    expect(
      await screen.findByRole('heading', { name: 'Choose a moment' }),
    ).toBeVisible()
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

  it('lets the owner reopen a saved sphere and enter memory-point editing', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/memory/shared-owned-sphere']}>
        <Routes>
          <Route
            path="/memory/:memoryId"
            element={(
              <PanoramaMemoryScreen
                onUpdateMomentAnnotations={vi.fn().mockResolvedValue(undefined)}
                sharedMoments={[
                  {
                    id: 'owned-sphere',
                    blob: new Blob(['panorama'], { type: 'image/jpeg' }),
                    objectUrl: 'blob:owned-sphere',
                    label: 'My saved sphere',
                    caption: '',
                    createdAt: new Date().toISOString(),
                    width: 4000,
                    height: 2000,
                    source: 'manual',
                    uploaderDisplayName: 'You',
                    ownedByCurrentUser: true,
                    familySynced: true,
                    annotations: [],
                  },
                ]}
              />
            )}
          />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(
      screen.getByRole('button', { name: 'Add memory point' }),
    )

    expect(
      screen.getByRole('button', { name: 'Add a memory point' }),
    ).toBeVisible()
  })

  it('saves a new point back to the same owned sphere', async () => {
    const user = userEvent.setup()
    const onUpdateMomentAnnotations = vi.fn().mockResolvedValue(undefined)
    render(
      <MemoryRouter initialEntries={['/memory/shared-owned-save']}>
        <Routes>
          <Route
            path="/memory/:memoryId"
            element={(
              <PanoramaMemoryScreen
                onUpdateMomentAnnotations={onUpdateMomentAnnotations}
                sharedMoments={[
                  {
                    id: 'owned-save',
                    blob: new Blob(['panorama'], { type: 'image/jpeg' }),
                    objectUrl: 'blob:owned-save',
                    label: 'My saved sphere',
                    caption: '',
                    createdAt: '2026-08-29T08:00:00.000Z',
                    width: 4000,
                    height: 2000,
                    source: 'manual',
                    uploaderDisplayName: 'You',
                    ownedByCurrentUser: true,
                    familySynced: false,
                    annotations: [],
                  },
                ]}
              />
            )}
          />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole('button', { name: 'Add memory point' }))
    await user.click(screen.getByRole('button', { name: 'Add a memory point' }))
    await user.click(screen.getByRole('button', { name: 'Place saved-scene point' }))
    await user.click(screen.getByRole('button', { name: /^Message/ }))
    await user.type(
      screen.getByRole('textbox', { name: 'Message' }),
      'The place we always sit',
    )
    await user.click(screen.getByRole('button', { name: 'Save message' }))
    await waitFor(() => expect(onUpdateMomentAnnotations).toHaveBeenCalledOnce())
    const done = screen.getByRole('button', { name: 'Done' })
    await waitFor(() => expect(done).toBeEnabled())
    await user.click(done)
    expect(onUpdateMomentAnnotations.mock.calls[0]?.[0]).toMatchObject({
      id: 'owned-save',
      blob: expect.any(Blob),
    })
    expect(onUpdateMomentAnnotations.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        kind: 'text',
        pitch: 14,
        yaw: -27,
        message: 'The place we always sit',
      }),
    ])
  })

  it('keeps an autosaved point available for retry when persistence fails', async () => {
    const user = userEvent.setup()
    const onUpdateMomentAnnotations = vi.fn()
      .mockRejectedValueOnce(new Error('Temporary family sync problem'))
      .mockResolvedValueOnce(undefined)
    render(
      <MemoryRouter initialEntries={['/memory/shared-owned-retry']}>
        <Routes>
          <Route
            path="/memory/:memoryId"
            element={(
              <PanoramaMemoryScreen
                onUpdateMomentAnnotations={onUpdateMomentAnnotations}
                sharedMoments={[
                  {
                    id: 'owned-retry',
                    blob: new Blob(['panorama'], { type: 'image/jpeg' }),
                    objectUrl: 'blob:owned-retry',
                    label: 'Retry sphere',
                    caption: '',
                    createdAt: '2026-08-29T08:00:00.000Z',
                    width: 4000,
                    height: 2000,
                    source: 'manual',
                    uploaderDisplayName: 'You',
                    ownedByCurrentUser: true,
                    familySynced: true,
                    annotations: [],
                  },
                ]}
              />
            )}
          />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole('button', { name: 'Add memory point' }))
    await user.click(screen.getByRole('button', { name: 'Add a memory point' }))
    await user.click(screen.getByRole('button', { name: 'Place saved-scene point' }))
    await user.click(screen.getByRole('button', { name: /^Message/ }))
    await user.type(
      screen.getByRole('textbox', { name: 'Message' }),
      'Keep this point while retrying',
    )
    await user.click(screen.getByRole('button', { name: 'Save message' }))

    const retry = await screen.findByRole('button', { name: 'Retry save' })
    expect(screen.getByText('Temporary family sync problem')).toBeVisible()
    await user.click(retry)

    await waitFor(() => expect(onUpdateMomentAnnotations).toHaveBeenCalledTimes(2))
    expect(onUpdateMomentAnnotations.mock.calls[1]?.[1]).toEqual(
      onUpdateMomentAnnotations.mock.calls[0]?.[1],
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled(),
    )
  })

  it('keeps a received sphere read-only for memory points', async () => {
    render(
      <MemoryRouter initialEntries={['/memory/shared-received-sphere']}>
        <Routes>
          <Route
            path="/memory/:memoryId"
            element={(
              <PanoramaMemoryScreen
                sharedMoments={[
                  {
                    id: 'received-sphere',
                    blob: new Blob(['panorama'], { type: 'image/jpeg' }),
                    objectUrl: 'blob:received-sphere',
                    label: 'Maya’s sphere',
                    caption: '',
                    createdAt: new Date().toISOString(),
                    width: 4000,
                    height: 2000,
                    source: 'manual',
                    uploaderDisplayName: 'Maya',
                    ownedByCurrentUser: false,
                    annotations: [],
                  },
                ]}
              />
            )}
          />
        </Routes>
      </MemoryRouter>,
    )

    expect(
      screen.queryByRole('button', { name: 'Add memory point' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Add a memory point' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Open family comments, 0 comments',
      }),
    ).toBeVisible()
  })

  it('opens an older received family upload as the actual panorama scene', async () => {
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
                    annotations: [
                      {
                        id: 'family-balcony-note',
                        kind: 'text',
                        pitch: -8,
                        yaw: 24,
                        message: 'Grandma planted this jasmine.',
                        audioUrl: null,
                      },
                    ],
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
      screen.getByRole('button', { name: 'Trigger voice hotspot' }),
    )
    expect(
      screen.getByRole('dialog', { name: 'Memory point' }),
    ).toHaveTextContent('Grandma planted this jasmine.')
    await user.click(screen.getByRole('button', { name: 'Close memory point' }))

    await user.click(
      screen.getByRole('button', { name: 'Set up Cardboard VR view' }),
    )
    expect(
      screen.queryByRole('heading', { name: 'Choose a moment' }),
    ).not.toBeInTheDocument()
    expect(
      within(screen.getByRole('dialog')).getByText('Family balcony'),
    ).toBeVisible()
    const landscapeOverride = screen.queryByRole('button', {
      name: 'Use split view anyway',
    })
    if (landscapeOverride) await user.click(landscapeOverride)
    await user.click(screen.getByRole('button', { name: 'Go' }))

    await waitFor(() => {
      const stereoViews = document.querySelectorAll('[data-panorama]')
      expect(stereoViews).toHaveLength(1)
      stereoViews.forEach((viewport) =>
        expect(viewport).toHaveAttribute('data-panorama', 'blob:family-balcony'),
      )
    })
  })

  it('plays a received voice point from inside the family panorama', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/memory/shared-family-kitchen']}>
        <Routes>
          <Route
            path="/memory/:memoryId"
            element={
              <PanoramaMemoryScreen
                sharedMoments={[
                  {
                    id: 'family-kitchen',
                    blob: new Blob(['panorama'], { type: 'image/jpeg' }),
                    objectUrl: 'blob:family-kitchen',
                    label: 'Family kitchen',
                    caption: 'Sunday lunch.',
                    createdAt: new Date().toISOString(),
                    width: 4000,
                    height: 2000,
                    source: 'manual',
                    uploaderDisplayName: 'Dad',
                    annotations: [
                      {
                        id: 'dad-voice-note',
                        kind: 'voice',
                        pitch: 3,
                        yaw: -18,
                        message: 'Dad explains the old recipe.',
                        audioBlob: new Blob(['voice'], { type: 'audio/mp4' }),
                        audioMimeType: 'audio/mp4',
                        durationMs: 4_200,
                        audioUrl: 'blob:dad-voice-note',
                      },
                    ],
                  },
                ]}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    )

    const voiceHotspot = await screen.findByRole('button', {
      name: 'Trigger voice hotspot',
    })
    expect(voiceHotspot).toHaveAttribute(
      'data-hotspot-label',
      'Play voice note: Dad explains the old recipe.',
    )
    await user.click(voiceHotspot)
    expect(screen.getByRole('dialog', { name: 'Memory point' })).toHaveTextContent(
      'Dad explains the old recipe.',
    )
    expect(screen.getByLabelText(
      'Voice note playback: Dad explains the old recipe.',
    )).toHaveAttribute(
      'src',
      'blob:dad-voice-note',
    )
  })

  it('explains how to retry when received voice audio is unavailable', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/memory/shared-missing-voice']}>
        <Routes>
          <Route
            path="/memory/:memoryId"
            element={(
              <PanoramaMemoryScreen
                sharedMoments={[
                  {
                    id: 'missing-voice',
                    blob: new Blob(['panorama'], { type: 'image/jpeg' }),
                    objectUrl: 'blob:missing-voice-panorama',
                    label: 'Family garden',
                    caption: 'A windy afternoon.',
                    createdAt: '2020-01-01T12:00:00.000Z',
                    width: 4000,
                    height: 2000,
                    source: 'manual',
                    uploaderDisplayName: 'Maya',
                    annotations: [
                      {
                        id: 'garden-story',
                        kind: 'voice',
                        pitch: 8,
                        yaw: 12,
                        message: 'Maya tells the story of the lemon tree.',
                        audioUrl: null,
                      },
                    ],
                  },
                ]}
              />
            )}
          />
        </Routes>
      </MemoryRouter>,
    )

    const voiceHotspot = await screen.findByRole('button', {
      name: 'Trigger voice hotspot',
    })
    expect(voiceHotspot).toHaveAttribute(
      'data-hotspot-label',
      'Voice note unavailable: Maya tells the story of the lemon tree.',
    )
    await user.click(voiceHotspot)

    expect(screen.getByText(
      /audio is unavailable.*check your connection/i,
    )).toHaveAttribute('role', 'status')
    expect(screen.queryByLabelText(/voice note playback/i)).not.toBeInTheDocument()
  })

  it('lets the family comment on the panorama and reply to an embedded point', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/memory/shared-family-comments']}>
        <Routes>
          <Route
            path="/memory/:memoryId"
            element={(
              <PanoramaMemoryScreen
                sharedMoments={[
                  {
                    id: 'family-comments',
                    blob: new Blob(['panorama'], { type: 'image/jpeg' }),
                    objectUrl: 'blob:family-comments',
                    label: 'Our new house',
                    caption: 'Walk through together.',
                    createdAt: new Date().toISOString(),
                    width: 4000,
                    height: 2000,
                    source: 'manual',
                    uploaderDisplayName: 'You',
                    annotations: [
                      {
                        id: 'hallway-note',
                        kind: 'voice',
                        pitch: 2,
                        yaw: 14,
                        message: 'Grandma describes where her clock will go.',
                        audioBlob: new Blob(['voice'], { type: 'audio/mp4' }),
                        audioMimeType: 'audio/mp4',
                        audioUrl: 'blob:grandma-clock-note',
                      },
                    ],
                  },
                ]}
              />
            )}
          />
        </Routes>
      </MemoryRouter>,
    )

    const commentsButton = await screen.findByRole('button', {
      name: 'Open family comments, 0 comments',
    })
    await user.click(commentsButton)
    expect(screen.getByRole('dialog', { name: 'Family comments' })).toBeVisible()
    expect(screen.getByText(/no comments yet/i)).toBeVisible()

    await user.type(
      screen.getByRole('textbox', { name: /comment on this whole moment/i }),
      'The light in here is beautiful.',
    )
    await user.click(screen.getByRole('button', { name: 'Post' }))
    expect(await screen.findByText('The light in here is beautiful.')).toBeVisible()
    expect(screen.getByText('On this device')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close comments' }))
    await waitFor(() => expect(commentsButton).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Trigger voice hotspot' }))
    await user.click(screen.getByRole('button', { name: 'Reply' }))
    expect(screen.getByText(/comment on/i)).toHaveTextContent(
      /Voice: Grandma describes where/i,
    )
    await user.type(
      screen.getByRole('textbox', {
        name: /comment on voice: grandma describes where/i,
      }),
      'I remember that clock!',
    )
    await user.click(screen.getByRole('button', { name: 'Post' }))

    expect(await screen.findByText('I remember that clock!')).toBeVisible()
    expect(screen.getByText(/reply to voice: grandma describes where/i)).toBeVisible()
    expect(screen.getByText('2 thoughts together')).toBeVisible()
  })
})
