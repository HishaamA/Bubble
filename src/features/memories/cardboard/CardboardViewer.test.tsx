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
  leftStartOrientation: vi.fn<PanoramaViewerHandle['startOrientation']>(),
  rightStartOrientation: vi.fn<PanoramaViewerHandle['startOrientation']>(),
  leftStopOrientation: vi.fn<PanoramaViewerHandle['stopOrientation']>(),
  rightStopOrientation: vi.fn<PanoramaViewerHandle['stopOrientation']>(),
  leftGetView: vi.fn<PanoramaViewerHandle['getView']>(),
  rightGetView: vi.fn<PanoramaViewerHandle['getView']>(),
  leftSetView: vi.fn<PanoramaViewerHandle['setView']>(),
  rightSetView: vi.fn<PanoramaViewerHandle['setView']>(),
  resize: vi.fn<PanoramaViewerHandle['resize']>(),
  destroy: vi.fn<PanoramaViewerHandle['destroy']>(),
  changeScene: vi.fn<PanoramaViewerHandle['changeScene']>(),
  deferReady: false,
  leftReadyCallback: null as (() => void) | null,
  rightReadyCallback: null as (() => void) | null,
}))

vi.mock('../../../viewer', async () => {
  const React = await import('react')

  return {
    PanoramaViewer: React.forwardRef<
      PanoramaViewerHandle,
      PanoramaViewerProps
    >(function MockPanoramaViewer(props, ref) {
      const { ariaLabel, onReady, onSceneChange, sceneId } = props
      const rightEye = ariaLabel?.includes('right eye') ?? false
      const scene = props.scenes.find(({ id }) => id === sceneId) ?? props.scenes[0]
      React.useImperativeHandle(
        ref,
        () => ({
          changeScene: viewerMocks.changeScene,
          getView: rightEye
            ? viewerMocks.rightGetView
            : viewerMocks.leftGetView,
          setView: rightEye
            ? viewerMocks.rightSetView
            : viewerMocks.leftSetView,
          startOrientation: rightEye
            ? viewerMocks.rightStartOrientation
            : viewerMocks.leftStartOrientation,
          stopOrientation: rightEye
            ? viewerMocks.rightStopOrientation
            : viewerMocks.leftStopOrientation,
          resize: viewerMocks.resize,
          destroy: viewerMocks.destroy,
        }),
        [rightEye],
      )
      React.useEffect(() => {
        if (!viewerMocks.deferReady) {
          onReady?.()
          return
        }

        const notifyReady = () => onReady?.()
        if (rightEye) {
          viewerMocks.rightReadyCallback = notifyReady
        } else {
          viewerMocks.leftReadyCallback = notifyReady
        }

        return () => {
          if (rightEye && viewerMocks.rightReadyCallback === notifyReady) {
            viewerMocks.rightReadyCallback = null
          }
          if (!rightEye && viewerMocks.leftReadyCallback === notifyReady) {
            viewerMocks.leftReadyCallback = null
          }
        }
      }, [onReady, rightEye])

      return (
        <button
          type="button"
          aria-label={ariaLabel}
          data-scene-id={sceneId}
          data-panorama={scene?.panorama}
          data-eye={rightEye ? 'right' : 'left'}
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
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('DeviceOrientationEvent', function DeviceOrientationEvent() {})
    viewerMocks.leftStartOrientation.mockResolvedValue(true)
    viewerMocks.rightStartOrientation.mockResolvedValue(true)
    viewerMocks.leftGetView.mockReturnValue({ pitch: 0, yaw: 0, hfov: 100 })
    viewerMocks.rightGetView.mockReturnValue({ pitch: 0, yaw: 0, hfov: 100 })
    viewerMocks.leftSetView.mockReturnValue(true)
    viewerMocks.rightSetView.mockReturnValue(true)
    viewerMocks.changeScene.mockReturnValue(true)
    viewerMocks.deferReady = false
    viewerMocks.leftReadyCallback = null
    viewerMocks.rightReadyCallback = null
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

  it('enters fullscreen and starts one shared motion source for both eyes', async () => {
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
      expect(viewerMocks.leftStartOrientation).toHaveBeenCalledOnce(),
    )
    expect(viewerMocks.rightStartOrientation).not.toHaveBeenCalled()
    expect(
      screen.getByText(/motion tracking active/i),
    ).toBeVisible()
  })

  it('mirrors gyroscope camera updates from the primary eye into the second eye', async () => {
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)
    await act(async () => {
      await ref.current?.enter()
    })

    viewerMocks.rightSetView.mockClear()
    const orientationView = { pitch: 18, yaw: 73, hfov: 92 }
    viewerMocks.leftGetView.mockReturnValue(orientationView)

    await waitFor(() =>
      expect(viewerMocks.rightSetView).toHaveBeenCalledWith(orientationView),
    )
    expect(viewerMocks.leftStartOrientation).toHaveBeenCalledOnce()
    expect(viewerMocks.rightStartOrientation).not.toHaveBeenCalled()
  })

  it('reattaches the primary gyro only after both refreshed eyes are ready', async () => {
    const ref = createRef<CardboardViewerHandle>()
    const { rerender } = render(
      <CardboardViewer ref={ref} scenes={scenes} />,
    )
    await act(async () => {
      await ref.current?.enter()
    })
    await waitFor(() =>
      expect(viewerMocks.leftStartOrientation).toHaveBeenCalledOnce(),
    )

    const refreshedScenes = scenes.map((scene) =>
      scene.id === 'dinner'
        ? { ...scene, panorama: '/media/dinner-refreshed.jpg' }
        : scene,
    )
    viewerMocks.deferReady = true
    rerender(<CardboardViewer ref={ref} scenes={refreshedScenes} />)

    await waitFor(() => {
      expect(viewerMocks.leftReadyCallback).toBeTypeOf('function')
      expect(viewerMocks.rightReadyCallback).toBeTypeOf('function')
      screen.getAllByText('Mock panorama').forEach((viewport) =>
        expect(viewport).toHaveAttribute(
          'data-panorama',
          '/media/dinner-refreshed.jpg',
        ),
      )
    })
    expect(viewerMocks.leftStartOrientation).toHaveBeenCalledOnce()
    expect(viewerMocks.leftStopOrientation).toHaveBeenCalled()

    act(() => viewerMocks.leftReadyCallback?.())
    expect(viewerMocks.leftStartOrientation).toHaveBeenCalledOnce()

    act(() => viewerMocks.rightReadyCallback?.())
    await waitFor(() =>
      expect(viewerMocks.leftStartOrientation).toHaveBeenCalledTimes(2),
    )
    expect(viewerMocks.rightStartOrientation).not.toHaveBeenCalled()
    expect(screen.getByText(/motion tracking active/i)).toBeVisible()
  })

  it('uses either touched eye as the shared drag source', async () => {
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)
    await act(async () => {
      await ref.current?.enter()
    })

    viewerMocks.leftSetView.mockClear()
    const draggedView = { pitch: -11, yaw: -48, hfov: 106 }
    viewerMocks.rightGetView.mockReturnValue(draggedView)
    const rightEye = document.querySelector<HTMLElement>(
      '.ks-cardboard__eye--right',
    )
    expect(rightEye).not.toBeNull()
    fireEvent.pointerDown(rightEye as HTMLElement)

    await waitFor(() =>
      expect(viewerMocks.leftSetView).toHaveBeenCalledWith(draggedView),
    )
    expect(viewerMocks.leftStopOrientation).toHaveBeenCalled()
    expect(screen.getByText(/manual look-around active/i)).toBeVisible()
  })

  it('mirrors the selected memory label in both Cardboard eyes', async () => {
    const ref = createRef<CardboardViewerHandle>()
    render(
      <CardboardViewer
        ref={ref}
        scenes={scenes}
        initialSceneId="dinner"
        memoryByline="Mum"
      />,
    )

    await act(async () => {
      await ref.current?.enter()
    })

    expect(screen.getAllByText('Sunday dinner')).toHaveLength(2)
    expect(screen.getAllByText('Mum')).toHaveLength(2)
    screen.getAllByText('Mock panorama').forEach((viewport) =>
      expect(viewport).toHaveAttribute('data-panorama', '/media/dinner.jpg'),
    )
  })

  it('explains that plain HTTP LAN pages cannot use phone motion', async () => {
    const requestPermission = vi.fn(async () => 'granted' as const)
    vi.stubGlobal('isSecureContext', false)
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission })
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)

    let result: Awaited<ReturnType<CardboardViewerHandle['enter']>> | undefined
    await act(async () => {
      result = await ref.current?.enter()
    })

    expect(result?.motionPermission).toBe('insecure')
    expect(requestPermission).not.toHaveBeenCalled()
    expect(viewerMocks.leftStartOrientation).not.toHaveBeenCalled()
    expect(screen.getByText(/needs https or the installed app/i)).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Enable motion' }),
    ).not.toBeInTheDocument()
  })

  it('uses synchronized drag when the browser exposes no sensor standard', async () => {
    vi.stubGlobal('DeviceOrientationEvent', undefined)
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)

    let result: Awaited<ReturnType<CardboardViewerHandle['enter']>> | undefined
    await act(async () => {
      result = await ref.current?.enter()
    })

    expect(result?.motionPermission).toBe('unsupported')
    expect(viewerMocks.leftStartOrientation).not.toHaveBeenCalled()
    expect(
      screen.getByText(/does not expose phone motion sensors/i),
    ).toBeVisible()
  })

  it('keeps Exit usable while the portrait rotation hint is visible', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(orientation: portrait)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })),
    )
    const onExit = vi.fn()
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} onExit={onExit} />)
    await act(async () => {
      await ref.current?.enter()
    })

    expect(screen.getByText('Rotate your phone')).toBeVisible()
    const exitButton = screen.getByRole('button', {
      name: 'Exit Cardboard view',
    })
    expect(exitButton).toBeVisible()
    await userEvent.click(exitButton)

    await waitFor(() => expect(onExit).toHaveBeenCalledOnce())
    expect(
      document.querySelector('.ks-cardboard'),
    ).toHaveAttribute('aria-hidden', 'true')
  })

  it('makes every app viewport inert and restores its exact prior state', async () => {
    const normalViewport = document.createElement('div')
    normalViewport.className = 'app-viewport'
    const underlyingButton = document.createElement('button')
    underlyingButton.textContent = 'Underlying navigation'
    normalViewport.append(underlyingButton)

    const alreadyInertViewport = document.createElement('div')
    alreadyInertViewport.className = 'app-viewport'
    alreadyInertViewport.setAttribute('inert', 'preserve-me')
    document.body.append(normalViewport, alreadyInertViewport)

    const ref = createRef<CardboardViewerHandle>()
    const { unmount } = render(<CardboardViewer ref={ref} scenes={scenes} />)

    try {
      await act(async () => {
        await ref.current?.enter()
      })
      expect(normalViewport).toHaveAttribute('inert', '')
      expect(alreadyInertViewport).toHaveAttribute('inert', '')

      await act(async () => {
        await ref.current?.exit()
      })
      expect(normalViewport).not.toHaveAttribute('inert')
      expect(alreadyInertViewport).toHaveAttribute('inert', 'preserve-me')

      await act(async () => {
        await ref.current?.enter()
      })
      expect(normalViewport).toHaveAttribute('inert', '')
      expect(alreadyInertViewport).toHaveAttribute('inert', '')

      unmount()
      expect(normalViewport).not.toHaveAttribute('inert')
      expect(alreadyInertViewport).toHaveAttribute('inert', 'preserve-me')
    } finally {
      normalViewport.remove()
      alreadyInertViewport.remove()
    }
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

    expect(viewerMocks.leftStartOrientation).not.toHaveBeenCalled()
    expect(viewerMocks.rightStartOrientation).not.toHaveBeenCalled()
    expect(screen.getByText(/motion access was not granted/i)).toBeVisible()

    await userEvent.click(
      screen.getByRole('button', { name: 'Enable motion' }),
    )
    await waitFor(() =>
      expect(viewerMocks.leftStartOrientation).toHaveBeenCalledOnce(),
    )
    expect(requestPermission).toHaveBeenCalledTimes(2)
    expect(viewerMocks.leftStartOrientation).toHaveBeenCalledWith({
      permissionAlreadyGranted: true,
    })
    expect(viewerMocks.rightStartOrientation).not.toHaveBeenCalled()
  })

  it('deduplicates repeated entry while motion permission is pending', async () => {
    let resolvePermission:
      | ((permission: 'denied' | 'granted') => void)
      | undefined
    const requestPermission = vi.fn(
      () =>
        new Promise<'denied' | 'granted'>((resolve) => {
          resolvePermission = resolve
        }),
    )
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission })

    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)

    let firstEntry: Promise<unknown> | undefined
    let repeatedEntry: Promise<unknown> | undefined
    act(() => {
      firstEntry = ref.current?.enter()
      repeatedEntry = ref.current?.enter()
    })

    expect(repeatedEntry).toBe(firstEntry)
    expect(requestPermission).toHaveBeenCalledOnce()
    expect(requestFullscreen).toHaveBeenCalledOnce()

    resolvePermission?.('granted')
    await act(async () => {
      await firstEntry
    })
  })

  it('requires a fresh user gesture after a pending exit settles', async () => {
    const requestPermission = vi.fn(async () => 'granted' as const)
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission })
    const onActiveChange = vi.fn()
    const ref = createRef<CardboardViewerHandle>()
    render(
      <CardboardViewer
        ref={ref}
        scenes={scenes}
        onActiveChange={onActiveChange}
      />,
    )
    await act(async () => {
      await ref.current?.enter()
    })
    expect(requestPermission).toHaveBeenCalledOnce()
    expect(requestFullscreen).toHaveBeenCalledOnce()
    expect(onActiveChange).toHaveBeenLastCalledWith(true)

    let completeExit: (() => void) | undefined
    exitFullscreen.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeExit = () => {
            fullscreenElement = null
            resolve()
          }
        }),
    )

    let pendingExit: Promise<void> | undefined
    act(() => {
      pendingExit = ref.current?.exit()
    })
    let blockedEntry: Promise<
      Awaited<ReturnType<CardboardViewerHandle['enter']>>
    > | undefined
    act(() => {
      blockedEntry = ref.current?.enter()
    })

    await expect(blockedEntry).rejects.toThrow(/still closing/i)
    expect(requestPermission).toHaveBeenCalledOnce()
    expect(requestFullscreen).toHaveBeenCalledOnce()
    expect(onActiveChange).not.toHaveBeenCalledWith(false)
    expect(document.querySelector('.ks-cardboard')).toHaveAttribute(
      'aria-hidden',
      'true',
    )

    await act(async () => {
      completeExit?.()
      await pendingExit
    })
    expect(onActiveChange).toHaveBeenLastCalledWith(false)

    let result:
      | Awaited<ReturnType<CardboardViewerHandle['enter']>>
      | undefined
    await act(async () => {
      result = await ref.current?.enter()
    })

    expect(result?.fullscreen).toBe(true)
    expect(requestPermission).toHaveBeenCalledTimes(2)
    expect(requestFullscreen).toHaveBeenCalledTimes(2)
    expect(
      screen.getByRole('dialog', { name: 'Cardboard panoramic memory' }),
    ).toBeVisible()
  })

  it('cleans up fullscreen when exit wins a pending permission request', async () => {
    let resolvePermission:
      | ((permission: 'denied' | 'granted') => void)
      | undefined
    vi.stubGlobal('DeviceOrientationEvent', {
      requestPermission: vi.fn(
        () =>
          new Promise<'denied' | 'granted'>((resolve) => {
            resolvePermission = resolve
          }),
      ),
    })

    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)
    let pendingEntry: Promise<unknown> | undefined
    act(() => {
      pendingEntry = ref.current?.enter()
    })
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await ref.current?.exit()
    })
    resolvePermission?.('granted')
    await act(async () => {
      await pendingEntry
    })

    expect(exitFullscreen).toHaveBeenCalledOnce()
    expect(viewerMocks.leftStartOrientation).not.toHaveBeenCalled()
    expect(viewerMocks.rightStartOrientation).not.toHaveBeenCalled()
    expect(
      document.querySelector('.ks-cardboard'),
    ).toHaveAttribute('aria-hidden', 'true')
  })

  it('leaves fullscreen that resolves after the session has already exited', async () => {
    let resolveFullscreen: (() => void) | undefined
    requestFullscreen.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFullscreen = () => {
            fullscreenElement = document.querySelector('.ks-cardboard')
            resolve()
          }
        }),
    )

    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)
    let pendingEntry: Promise<unknown> | undefined
    act(() => {
      pendingEntry = ref.current?.enter()
    })

    await act(async () => {
      await ref.current?.exit()
    })
    resolveFullscreen?.()
    await act(async () => {
      await pendingEntry
    })

    expect(exitFullscreen).toHaveBeenCalledOnce()
    expect(fullscreenElement).toBeNull()
  })

  it('keeps a usable overlay when fullscreen is rejected', async () => {
    requestFullscreen.mockRejectedValueOnce(new Error('blocked'))
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)

    let result: Awaited<ReturnType<CardboardViewerHandle['enter']>> | undefined
    await act(async () => {
      result = await ref.current?.enter()
    })

    expect(result?.fullscreen).toBe(false)
    expect(
      screen.getByRole('dialog', { name: 'Cardboard panoramic memory' }),
    ).toBeVisible()
    expect(screen.getByText(/fullscreen is unavailable/i)).toBeVisible()
  })

  it('continues when landscape orientation locking is rejected', async () => {
    const originalOrientation = Object.getOwnPropertyDescriptor(
      globalThis.screen,
      'orientation',
    )
    const lock = vi.fn().mockRejectedValue(new Error('not allowed'))
    const unlock = vi.fn()
    Object.defineProperty(globalThis.screen, 'orientation', {
      configurable: true,
      value: { lock, unlock },
    })

    try {
      const ref = createRef<CardboardViewerHandle>()
      render(<CardboardViewer ref={ref} scenes={scenes} />)

      let result:
        | Awaited<ReturnType<CardboardViewerHandle['enter']>>
        | undefined
      await act(async () => {
        result = await ref.current?.enter()
      })

      expect(result?.fullscreen).toBe(true)
      expect(lock).toHaveBeenCalledWith('landscape')
      expect(
        screen.getByRole('dialog', { name: 'Cardboard panoramic memory' }),
      ).toBeVisible()
    } finally {
      if (originalOrientation) {
        Object.defineProperty(
          globalThis.screen,
          'orientation',
          originalOrientation,
        )
      } else {
        Reflect.deleteProperty(globalThis.screen, 'orientation')
      }
    }
  })

  it('leaves owned fullscreen when the active viewer unmounts', async () => {
    const ref = createRef<CardboardViewerHandle>()
    const { unmount } = render(<CardboardViewer ref={ref} scenes={scenes} />)
    await act(async () => {
      await ref.current?.enter()
    })

    unmount()

    await waitFor(() => expect(exitFullscreen).toHaveBeenCalledOnce())
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
      expect(viewerMocks.leftStartOrientation).toHaveBeenCalledOnce(),
    )

    fullscreenElement = null
    fireEvent(document, new Event('fullscreenchange'))

    await waitFor(() => expect(onExit).toHaveBeenCalledOnce())
    expect(viewerMocks.leftStopOrientation).toHaveBeenCalledOnce()
    expect(viewerMocks.rightStopOrientation).toHaveBeenCalledTimes(2)
    expect(container).toBeEmptyDOMElement()
    expect(
      document.querySelector('.ks-cardboard'),
    ).toHaveAttribute('aria-hidden', 'true')
  })
})
