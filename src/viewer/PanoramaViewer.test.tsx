import { createRef } from 'react'
import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PanoramaViewer, type PanoramaViewerHandle } from './PanoramaViewer'
import type {
  PanoramaAdapter,
  PanoramaMountOptions,
  PanoramaScene,
} from './types'

const viewerMocks = vi.hoisted(() => ({
  mount: vi.fn<
    (container: HTMLElement, options: PanoramaMountOptions) => Promise<void>
  >(),
  changeScene: vi.fn<PanoramaAdapter['changeScene']>(),
  startOrientation: vi.fn<PanoramaAdapter['startOrientation']>(),
  stopOrientation: vi.fn<PanoramaAdapter['stopOrientation']>(),
  isOrientationSupported: vi.fn<
    PanoramaAdapter['isOrientationSupported']
  >(),
  isOrientationActive: vi.fn<PanoramaAdapter['isOrientationActive']>(),
  getView: vi.fn<PanoramaAdapter['getView']>(),
  setView: vi.fn<PanoramaAdapter['setView']>(),
  panBy: vi.fn<PanoramaAdapter['panBy']>(),
  zoomIn: vi.fn<PanoramaAdapter['zoomIn']>(),
  zoomOut: vi.fn<PanoramaAdapter['zoomOut']>(),
  resize: vi.fn<PanoramaAdapter['resize']>(),
  destroy: vi.fn<PanoramaAdapter['destroy']>(),
}))

vi.mock('./PannellumAdapter', () => ({
  createPannellumAdapter: () => viewerMocks,
}))

const playVoiceNote = vi.fn()
const scenes: readonly PanoramaScene[] = [
  {
    id: 'dinner',
    panorama: '/media/dinner.jpg',
    alt: 'A family gathered for dinner.',
    title: 'Sunday dinner',
    hotSpots: [
      {
        id: 'voice-note',
        kind: 'audio',
        pitch: -12,
        yaw: -20,
        label: 'Play the dinner voice note',
        onActivate: playVoiceNote,
      },
      {
        id: 'courtyard-door',
        kind: 'scene',
        pitch: 0,
        yaw: 32,
        label: 'Open the courtyard',
        sceneId: 'courtyard',
      },
    ],
  },
  {
    id: 'courtyard',
    panorama: '/media/courtyard.jpg',
    alt: 'A sunny family courtyard.',
    title: 'Courtyard',
  },
]

describe('PanoramaViewer accessibility controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    viewerMocks.mount.mockImplementation(async (_container, options) => {
      options.onLoad?.()
    })
    viewerMocks.changeScene.mockReturnValue(true)
    viewerMocks.isOrientationSupported.mockReturnValue(false)
    viewerMocks.isOrientationActive.mockReturnValue(false)
    viewerMocks.startOrientation.mockResolvedValue(false)
  })

  it('scopes arrow-key panning to the focused interactive canvas', async () => {
    const { container } = render(<PanoramaViewer scenes={scenes} />)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'View as a flat image' }),
      ).toBeEnabled(),
    )
    const canvas = container.querySelector<HTMLDivElement>(
      '.ks-panorama__canvas',
    )
    expect(canvas).not.toBeNull()

    const arrowEvent = createEvent.keyDown(canvas as HTMLDivElement, {
      key: 'ArrowRight',
      cancelable: true,
    })
    fireEvent(canvas as HTMLDivElement, arrowEvent)

    expect(arrowEvent.defaultPrevented).toBe(true)
    expect(viewerMocks.panBy).toHaveBeenCalledWith(0, 8)
  })

  it('exposes an immediate camera snapshot bridge for Cardboard mirroring', async () => {
    const ref = createRef<PanoramaViewerHandle>()
    const view = { pitch: 14, yaw: -32, hfov: 96 }
    viewerMocks.getView.mockReturnValue(view)
    viewerMocks.setView.mockReturnValue(true)
    render(<PanoramaViewer ref={ref} scenes={scenes} />)
    await waitFor(() => expect(viewerMocks.mount).toHaveBeenCalled())

    expect(ref.current?.getView()).toEqual(view)
    expect(ref.current?.setView(view)).toBe(true)
    expect(viewerMocks.setView).toHaveBeenCalledWith(view)
  })

  it('makes the canvas inert in flat mode and does not intercept ArrowDown on its scene select', async () => {
    const user = userEvent.setup()
    const { container } = render(<PanoramaViewer scenes={scenes} />)
    const flatViewButton = await screen.findByRole('button', {
      name: 'View as a flat image',
    })
    await waitFor(() => expect(flatViewButton).toBeEnabled())
    await user.click(flatViewButton)

    const canvas = container.querySelector<HTMLDivElement>(
      '.ks-panorama__canvas',
    )
    expect(canvas).toHaveAttribute('aria-hidden', 'true')
    expect(canvas).toHaveAttribute('inert')
    expect(canvas).toHaveAttribute('tabindex', '-1')

    const sceneSelect = screen.getByRole('combobox', { name: 'Memory' })
    const arrowEvent = createEvent.keyDown(sceneSelect, {
      key: 'ArrowDown',
      cancelable: true,
    })
    fireEvent(sceneSelect, arrowEvent)

    expect(arrowEvent.defaultPrevented).toBe(false)
    expect(viewerMocks.panBy).not.toHaveBeenCalled()
  })

  it('offers equivalent audio and linked-scene actions in flat mode', async () => {
    const user = userEvent.setup()
    render(<PanoramaViewer scenes={scenes} />)
    const flatViewButton = await screen.findByRole('button', {
      name: 'View as a flat image',
    })
    await waitFor(() => expect(flatViewButton).toBeEnabled())
    await user.click(flatViewButton)

    expect(
      screen.getByRole('heading', { name: 'Memory points' }),
    ).toBeVisible()
    await user.click(
      screen.getByRole('button', { name: /play the dinner voice note/i }),
    )
    expect(playVoiceNote).toHaveBeenCalledOnce()

    await user.click(
      screen.getByRole('button', { name: /open the courtyard/i }),
    )
    expect(viewerMocks.changeScene).toHaveBeenCalledWith('courtyard')
    expect(
      screen.getByRole('img', { name: 'A sunny family courtyard.' }),
    ).toBeVisible()
  })

  it('keeps motion unpressed until async permission succeeds and announces denial', async () => {
    let resolvePermission: ((active: boolean) => void) | undefined
    const permission = new Promise<boolean>((resolve) => {
      resolvePermission = resolve
    })
    viewerMocks.isOrientationSupported.mockReturnValue(true)
    viewerMocks.startOrientation.mockReturnValue(permission)

    const user = userEvent.setup()
    render(<PanoramaViewer scenes={scenes} />)
    const motionButton = await screen.findByRole('button', {
      name: 'Turn motion control on',
    })
    await waitFor(() => expect(motionButton).toBeEnabled())
    await user.click(motionButton)

    expect(motionButton).toHaveAttribute('aria-pressed', 'false')
    expect(motionButton).toHaveAttribute('aria-busy', 'true')
    resolvePermission?.(false)

    expect(
      await screen.findByText(/motion access was not granted/i),
    ).toBeVisible()
    expect(motionButton).toHaveAttribute('aria-pressed', 'false')
    expect(motionButton).toHaveAttribute('aria-busy', 'false')
  })
})
