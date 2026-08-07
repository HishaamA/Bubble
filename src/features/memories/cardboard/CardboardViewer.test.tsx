import { act, createRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanoramaScene } from '../../../viewer'
import {
  CardboardViewer,
  type CardboardViewerHandle,
} from './CardboardViewer'

const stereoMocks = vi.hoisted(() => ({
  startOrientation: vi.fn<
    (options?: { permissionAlreadyGranted?: boolean }) => Promise<boolean>
  >(),
  stopOrientation: vi.fn<() => void>(),
  resize: vi.fn<() => void>(),
  deferReady: false,
  readyCallback: null as (() => void) | null,
  lastProps: null as null | {
    scene: PanoramaScene
    ariaLabel: string
    opticalCenterShift?: number
  },
}))

const nativeOrientationMocks = vi.hoisted(() => ({
  available: vi.fn(() => false),
  requestLandscape: vi.fn(() => Promise.resolve(false)),
  restoreAppOrientation: vi.fn(() => Promise.resolve(false)),
}))

vi.mock('./nativeCardboardOrientation', () => ({
  nativeCardboardOrientationAvailable: nativeOrientationMocks.available,
  requestNativeCardboardLandscape: nativeOrientationMocks.requestLandscape,
  restoreNativeAppOrientation: nativeOrientationMocks.restoreAppOrientation,
}))

vi.mock('./StereoPanoramaRenderer', async () => {
  const React = await import('react')

  type MockProps = {
    scene: PanoramaScene
    ariaLabel: string
    opticalCenterShift?: number
    onReady?: () => void
  }

  return {
    StereoPanoramaRenderer: React.forwardRef(function MockStereoPanoramaRenderer(
      props: MockProps,
      ref: React.ForwardedRef<{
        startOrientation: typeof stereoMocks.startOrientation
        stopOrientation: typeof stereoMocks.stopOrientation
        resize: typeof stereoMocks.resize
      }>,
    ) {
      stereoMocks.lastProps = props
      React.useImperativeHandle(
        ref,
        () => ({
          startOrientation: stereoMocks.startOrientation,
          stopOrientation: stereoMocks.stopOrientation,
          resize: stereoMocks.resize,
        }),
        [],
      )
      React.useEffect(() => {
        const notifyReady = () => props.onReady?.()
        if (stereoMocks.deferReady) {
          stereoMocks.readyCallback = notifyReady
        } else {
          notifyReady()
        }
        return () => {
          if (stereoMocks.readyCallback === notifyReady) {
            stereoMocks.readyCallback = null
          }
        }
      }, [props.scene])

      return (
        <div
          role="img"
          aria-label={props.ariaLabel}
          data-renderer="single-canvas-stereo"
          data-panorama={props.scene.panorama}
          data-optical-center-shift={props.opticalCenterShift}
        />
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
let viewportWidth = 844
let viewportHeight = 390
let originalRequestFullscreen: PropertyDescriptor | undefined
let originalExitFullscreen: PropertyDescriptor | undefined
let originalFullscreenElement: PropertyDescriptor | undefined
let originalInnerWidth: PropertyDescriptor | undefined
let originalInnerHeight: PropertyDescriptor | undefined

function setViewport(width: number, height: number) {
  viewportWidth = width
  viewportHeight = height
  window.dispatchEvent(new Event('resize'))
}

function restoreProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor)
  } else {
    Reflect.deleteProperty(target, property)
  }
}

async function enterViewer(
  ref: React.RefObject<CardboardViewerHandle | null>,
  options?: { forceLandscape?: boolean },
) {
  await act(async () => {
    await ref.current?.enter(options)
  })
}

describe('CardboardViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('DeviceOrientationEvent', function DeviceOrientationEvent() {})
    stereoMocks.startOrientation.mockResolvedValue(true)
    stereoMocks.deferReady = false
    stereoMocks.readyCallback = null
    stereoMocks.lastProps = null
    nativeOrientationMocks.available.mockReturnValue(false)
    nativeOrientationMocks.requestLandscape.mockResolvedValue(false)
    nativeOrientationMocks.restoreAppOrientation.mockResolvedValue(false)
    fullscreenElement = null
    viewportWidth = 844
    viewportHeight = 390

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
    originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      get: () => viewportWidth,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      get: () => viewportHeight,
    })
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: vi.fn(() => {
        fullscreenElement = document.querySelector('.ks-cardboard')
        return Promise.resolve()
      }),
    })
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: vi.fn(() => {
        fullscreenElement = null
        return Promise.resolve()
      }),
    })
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    restoreProperty(
      HTMLElement.prototype,
      'requestFullscreen',
      originalRequestFullscreen,
    )
    restoreProperty(document, 'exitFullscreen', originalExitFullscreen)
    restoreProperty(document, 'fullscreenElement', originalFullscreenElement)
    restoreProperty(window, 'innerWidth', originalInnerWidth)
    restoreProperty(window, 'innerHeight', originalInnerHeight)
  })

  it('starts phone motion automatically and keeps routine motion controls hidden', async () => {
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)

    await enterViewer(ref)

    await waitFor(() =>
      expect(stereoMocks.startOrientation).toHaveBeenCalledOnce(),
    )
    expect(stereoMocks.startOrientation).toHaveBeenCalledWith({
      permissionAlreadyGranted: false,
    })
    expect(
      screen.queryByRole('button', { name: /enable motion/i }),
    ).not.toBeInTheDocument()
    expect(document.querySelector('.ks-cardboard__status-panel')).toBeNull()
  })

  it('uses one stereo renderer with both reticles geometrically centered', async () => {
    const ref = createRef<CardboardViewerHandle>()
    render(
      <CardboardViewer
        ref={ref}
        scenes={scenes}
        initialSceneId="dinner"
        memoryByline="Simreen"
      />,
    )

    await enterViewer(ref)

    expect(
      screen.getAllByRole('img', { name: /synchronized left and right eye/i }),
    ).toHaveLength(1)
    expect(stereoMocks.lastProps?.scene.id).toBe('dinner')
    expect(stereoMocks.lastProps?.opticalCenterShift).toBe(0)
    expect(document.querySelectorAll('.ks-cardboard__reticle')).toHaveLength(2)
    expect(screen.getAllByText('Sunday dinner')).toHaveLength(2)
    expect(screen.getAllByText('Simreen')).toHaveLength(2)
  })

  it('passes an already granted iOS motion permission into the renderer', async () => {
    const requestPermission = vi.fn(() => Promise.resolve('granted' as const))
    class PermissionDeviceOrientationEvent {}
    Object.assign(PermissionDeviceOrientationEvent, { requestPermission })
    vi.stubGlobal('DeviceOrientationEvent', PermissionDeviceOrientationEvent)
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)

    await enterViewer(ref)

    expect(requestPermission).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(stereoMocks.startOrientation).toHaveBeenCalledWith({
        permissionAlreadyGranted: true,
      }),
    )
  })

  it('shows passive fallback guidance without adding another button', async () => {
    const requestPermission = vi.fn(() => Promise.resolve('denied' as const))
    class PermissionDeviceOrientationEvent {}
    Object.assign(PermissionDeviceOrientationEvent, { requestPermission })
    vi.stubGlobal('DeviceOrientationEvent', PermissionDeviceOrientationEvent)
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)

    await enterViewer(ref)

    expect(screen.getByText(/motion access is off/i)).toBeVisible()
    expect(stereoMocks.startOrientation).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('button', { name: /enable motion/i }),
    ).not.toBeInTheDocument()
  })

  it('offers a reachable forced-landscape override when rotation is not detected', async () => {
    setViewport(390, 844)
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)

    await enterViewer(ref)

    expect(screen.getByText('Rotate your phone')).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Use split view anyway' }),
    )
    expect(
      screen.getByRole('dialog', { name: 'Cardboard panoramic memory' }),
    ).toHaveClass('ks-cardboard--forced-landscape')
  })

  it('uses native iOS landscape without requesting browser fullscreen', async () => {
    nativeOrientationMocks.available.mockReturnValue(true)
    nativeOrientationMocks.requestLandscape.mockResolvedValue(true)
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} />)

    await enterViewer(ref)

    expect(nativeOrientationMocks.requestLandscape).toHaveBeenCalledOnce()
    expect(HTMLElement.prototype.requestFullscreen).not.toHaveBeenCalled()
    nativeOrientationMocks.restoreAppOrientation.mockClear()

    await userEvent.click(
      screen.getByRole('button', { name: 'Exit Cardboard view' }),
    )

    expect(nativeOrientationMocks.restoreAppOrientation).toHaveBeenCalledOnce()
  })

  it('stops motion and closes through the single Exit control', async () => {
    const onExit = vi.fn()
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} onExit={onExit} />)
    await enterViewer(ref)
    await waitFor(() =>
      expect(stereoMocks.startOrientation).toHaveBeenCalledOnce(),
    )
    stereoMocks.stopOrientation.mockClear()

    await userEvent.click(
      screen.getByRole('button', { name: 'Exit Cardboard view' }),
    )

    await waitFor(() => expect(onExit).toHaveBeenCalledOnce())
    expect(stereoMocks.stopOrientation).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole('dialog', { name: 'Cardboard panoramic memory' }),
    ).not.toBeInTheDocument()
  })

  it('notifies the app immediately while native portrait restoration finishes', async () => {
    nativeOrientationMocks.available.mockReturnValue(true)
    nativeOrientationMocks.requestLandscape.mockResolvedValue(true)
    let finishRestore: ((value: boolean) => void) | undefined
    nativeOrientationMocks.restoreAppOrientation.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishRestore = resolve
        }),
    )
    const onExit = vi.fn()
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} onExit={onExit} />)
    await enterViewer(ref)

    await userEvent.click(
      screen.getByRole('button', { name: 'Exit Cardboard view' }),
    )

    expect(onExit).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole('dialog', { name: 'Cardboard panoramic memory' }),
    ).not.toBeInTheDocument()

    await act(async () => finishRestore?.(true))
  })

  it('closes if browser fullscreen is dismissed externally', async () => {
    const onExit = vi.fn()
    const ref = createRef<CardboardViewerHandle>()
    render(<CardboardViewer ref={ref} scenes={scenes} onExit={onExit} />)
    await enterViewer(ref)
    await waitFor(() =>
      expect(stereoMocks.startOrientation).toHaveBeenCalledOnce(),
    )
    stereoMocks.stopOrientation.mockClear()

    fullscreenElement = null
    fireEvent(document, new Event('fullscreenchange'))

    await waitFor(() => expect(onExit).toHaveBeenCalledOnce())
    expect(stereoMocks.stopOrientation).toHaveBeenCalledOnce()
  })

  it('reattaches motion after the selected scene object refreshes', async () => {
    const ref = createRef<CardboardViewerHandle>()
    const { rerender } = render(<CardboardViewer ref={ref} scenes={scenes} />)
    await enterViewer(ref)
    await waitFor(() =>
      expect(stereoMocks.startOrientation).toHaveBeenCalledOnce(),
    )

    stereoMocks.deferReady = true
    const refreshedScenes = scenes.map((scene) => ({ ...scene }))
    rerender(<CardboardViewer ref={ref} scenes={refreshedScenes} />)

    await waitFor(() => expect(stereoMocks.readyCallback).not.toBeNull())
    await act(async () => {
      stereoMocks.readyCallback?.()
    })

    await waitFor(() =>
      expect(stereoMocks.startOrientation).toHaveBeenCalledTimes(2),
    )
  })
})
