import { act, createRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PanoramaScene,
  PanoramaViewerHandle,
  PanoramaViewerProps,
} from '../../../viewer'
import {
  CardboardViewer,
  type CardboardViewerHandle,
} from './CardboardViewer'

const viewerMocks = vi.hoisted(() => ({
  startOrientation: vi.fn<PanoramaViewerHandle['startOrientation']>(),
  stopOrientation: vi.fn<PanoramaViewerHandle['stopOrientation']>(),
  resize: vi.fn<PanoramaViewerHandle['resize']>(),
  destroy: vi.fn<PanoramaViewerHandle['destroy']>(),
  changeScene: vi.fn<PanoramaViewerHandle['changeScene']>(),
}))

vi.mock('../../../viewer', async () => {
  const React = await import('react')

  return {
    PanoramaViewer: React.forwardRef<
      PanoramaViewerHandle,
      PanoramaViewerProps
    >(function MockPanoramaViewer(props, ref) {
      const { ariaLabel, onReady, onSceneChange, sceneId } = props
      React.useImperativeHandle(
        ref,
        () => ({
          changeScene: viewerMocks.changeScene,
          startOrientation: viewerMocks.startOrientation,
          stopOrientation: viewerMocks.stopOrientation,
          resize: viewerMocks.resize,
          destroy: viewerMocks.destroy,
        }),
        [],
      )
      React.useEffect(() => onReady?.(), [onReady])

      return (
        <button
          type="button"
          aria-label={ariaLabel}
          data-scene-id={sceneId}
          onClick={() => onSceneChange?.('courtyard')}
        >
          Mock panorama
        </button>
      )
    }),
  }
})

const scenes: readonly PanoramaScene[] = [
  {
    id: 'dinner',
    panorama: '/media/dinner.jpg',
    alt: 'A family gathered for dinner.',
    title: 'Sunday dinner',
  },
  {
    id: 'courtyard',
    panorama: '/media/courtyard.jpg',
    alt: 'A sunny family courtyard.',
    title: 'Courtyard',
  },
]

let fullscreenElement: Element | null
let requestFullscreen: ReturnType<typeof vi.fn>
let exitFullscreen: ReturnType<typeof vi.fn>
let originalRequestFullscreen: PropertyDescriptor | undefined
let originalExitFullscreen: PropertyDescriptor | undefined
let originalFullscreenElement: PropertyDescriptor | undefined

describe('CardboardViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    viewerMocks.startOrientation.mockResolvedValue(true)
    viewerMocks.changeScene.mockReturnValue(true)
    fullscreenElement = null

    originalRequestFullscreen = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'requestFullscreen',
    )
    originalExitFullscreen = Object.getOwnPropertyDescriptor(
      document,
      'exitFullscreen',
    )
    originalFullscreenElement = Object.getOwnPropertyDescriptor(
      document,
      'fullscreenElement',
    )

    requestFullscreen = vi.fn(() => {
      fullscreenElement = document.querySelector('.ks-cardboard')
      return Promise.resolve()
    })
    exitFullscreen = vi.fn(() => {
      fullscreenElement = null
      return Promise.resolve()
    })
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    })
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalRequestFullscreen) {
      Object.defineProperty(
        HTMLElement.prototype,
        'requestFullscreen',
        originalRequestFullscreen,
      )
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen')
    }
    if (originalExitFullscreen) {
      Object.defineProperty(
        document,
        'exitFullscreen',
        originalExitFullscreen,
      )
    } else {
      Reflect.deleteProperty(document, 'exitFullscreen')
    }
    if (originalFullscreenElement) {
      Object.defineProperty(
        document,
        'fullscreenElement',
        originalFullscreenElement,
      )
    } else {
      Reflect.deleteProperty(document, 'fullscreenElement')
    }
  })

  it('enters fullscreen and starts motion in both synchronized eye views', async () => {
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)

    await act(async () => {
      await ref.current?.enter()
    })

    expect(
      screen.getByRole('dialog', { name: 'Cardboard panoramic memory' }),
    ).toBeVisible()
    expect(requestFullscreen).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(viewerMocks.startOrientation).toHaveBeenCalledTimes(2),
    )
    expect(
      screen.getByText(/motion tracking active/i),
    ).toBeVisible()
  })

  it('propagates a doorway scene change from one eye to both viewports', async () => {
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} initialSceneId="dinner" />)
    await act(async () => {
      await ref.current?.enter()
    })

    const leftEye = screen.getByRole('button', {
      name: /cardboard panoramic memory, left eye/i,
    })
    fireEvent.click(leftEye)

    await waitFor(() => {
      const viewports = screen.getAllByText('Mock panorama')
      expect(viewports).toHaveLength(2)
      viewports.forEach((viewport) =>
        expect(viewport).toHaveAttribute('data-scene-id', 'courtyard'),
      )
    })
  })

  it('offers a user-gesture retry after motion permission is denied', async () => {
    const requestPermission = vi
      .fn<() => Promise<'denied' | 'granted'>>()
      .mockResolvedValueOnce('denied')
      .mockResolvedValueOnce('granted')
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission })

    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)
    await act(async () => {
      await ref.current?.enter()
    })

    expect(viewerMocks.startOrientation).not.toHaveBeenCalled()
    expect(screen.getByText(/motion access was not granted/i)).toBeVisible()

    await userEvent.click(
      screen.getByRole('button', { name: 'Enable motion' }),
    )
    await waitFor(() =>
      expect(viewerMocks.startOrientation).toHaveBeenCalledTimes(2),
    )
    expect(requestPermission).toHaveBeenCalledOnce()
  })

  it('stops both viewers and closes when fullscreen is dismissed externally', async () => {
    const onExit = vi.fn()
    const ref = createRef<CardboardViewerHandle>()
    const { container } = render(
      <CardboardViewer ref={ref} scenes={scenes} onExit={onExit} />,
    )
    await act(async () => {
      await ref.current?.enter()
    })
    await waitFor(() =>
      expect(viewerMocks.startOrientation).toHaveBeenCalledTimes(2),
    )

    fullscreenElement = null
    fireEvent(document, new Event('fullscreenchange'))

    await waitFor(() => expect(onExit).toHaveBeenCalledOnce())
    expect(viewerMocks.stopOrientation).toHaveBeenCalledTimes(2)
    expect(container).toBeEmptyDOMElement()
    expect(
      document.querySelector('.ks-cardboard'),
    ).toHaveAttribute('aria-hidden', 'true')
  })
})
