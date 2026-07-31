import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  PanoramaViewer,
  type PanoramaScene,
  type PanoramaViewerHandle,
} from '../../../viewer'
import './CardboardViewer.css'

export type CardboardMotionPermission =
  | 'granted'
  | 'not-required'
  | 'denied'

export interface CardboardEntryResult {
  fullscreen: boolean
  motionPermission: CardboardMotionPermission
}

export interface CardboardViewerHandle {
  /** Call directly from the VR button's click handler to preserve user activation. */
  enter: () => Promise<CardboardEntryResult>
  exit: () => Promise<void>
}

export interface CardboardViewerProps {
  scenes: readonly PanoramaScene[]
  initialSceneId?: string
  ariaLabel?: string
  onActiveChange?: (active: boolean) => void
  onSceneChange?: (sceneId: string) => void
  onExit?: () => void
}

type MotionStatus =
  | 'idle'
  | 'preparing'
  | 'starting'
  | 'active'
  | 'partial'
  | 'unavailable'
  | 'denied'

type PermissionCapableDeviceOrientationEvent = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'denied' | 'granted'>
}

type WebkitFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

type WebkitFullscreenDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void
  webkitFullscreenElement?: Element | null
}

type LockableScreenOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape') => Promise<void>
  unlock?: () => void
}

const MOTION_MESSAGES: Record<MotionStatus, string> = {
  idle: 'Motion tracking is ready to begin.',
  preparing: 'Preparing the Cardboard view…',
  starting: 'Starting phone motion tracking…',
  active: 'Motion tracking active. Turn your head to look around.',
  partial:
    'Motion tracking started in one view only. Remove the headset and try again.',
  unavailable:
    'Motion tracking is unavailable. You can still drag the left view to look around.',
  denied:
    'Motion access was not granted. Use Enable motion to try again.',
}

function resolveInitialSceneId(
  scenes: readonly PanoramaScene[],
  requestedSceneId?: string,
): string {
  if (requestedSceneId && scenes.some(({ id }) => id === requestedSceneId)) {
    return requestedSceneId
  }
  return scenes[0]?.id ?? ''
}

async function requestMotionPermission(): Promise<CardboardMotionPermission> {
  const orientationEvent = globalThis.DeviceOrientationEvent as
    | PermissionCapableDeviceOrientationEvent
    | undefined
  const requestPermission = orientationEvent?.requestPermission

  if (!requestPermission) return 'not-required'

  try {
    return (await requestPermission.call(orientationEvent)) === 'granted'
      ? 'granted'
      : 'denied'
  } catch {
    return 'denied'
  }
}

async function requestElementFullscreen(element: HTMLElement): Promise<boolean> {
  const fullscreenElement = element as WebkitFullscreenElement
  const request =
    element.requestFullscreen ?? fullscreenElement.webkitRequestFullscreen

  if (!request) return false

  try {
    await request.call(element)
    return true
  } catch {
    return false
  }
}

function currentFullscreenElement(): Element | null {
  const fullscreenDocument = document as WebkitFullscreenDocument
  return (
    document.fullscreenElement ??
    fullscreenDocument.webkitFullscreenElement ??
    null
  )
}

async function leaveOwnedFullscreen(
  root: HTMLElement | null,
  fullscreenWasRequested: boolean,
): Promise<void> {
  if (!fullscreenWasRequested) return

  const fullscreenDocument = document as WebkitFullscreenDocument
  const currentElement = currentFullscreenElement()
  if (currentElement && currentElement !== root) return

  const exit =
    document.exitFullscreen ?? fullscreenDocument.webkitExitFullscreen
  if (!exit) return

  try {
    await exit.call(document)
  } catch {
    // The browser may already have left fullscreen using its own controls.
  }
}

async function lockLandscape(): Promise<void> {
  const orientation = globalThis.screen?.orientation as
    | LockableScreenOrientation
    | undefined
  if (!orientation?.lock) return

  try {
    await orientation.lock('landscape')
  } catch {
    // Orientation locking is best effort and usually requires fullscreen.
  }
}

function unlockOrientation(): void {
  const orientation = globalThis.screen?.orientation as
    | LockableScreenOrientation
    | undefined
  try {
    orientation?.unlock?.()
  } catch {
    // Some browsers expose unlock but reject it outside fullscreen.
  }
}

function isPortraitViewport(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(orientation: portrait)').matches
  }
  return window.innerHeight > window.innerWidth
}

function CardboardGlyph() {
  return (
    <svg viewBox="0 0 32 22" aria-hidden="true">
      <path d="M3.2 5.2h25.6v12.1a2 2 0 0 1-2 2h-5.2l-3.4-5.1h-4.4l-3.4 5.1H5.2a2 2 0 0 1-2-2z" />
      <circle cx="9.2" cy="11.2" r="3.1" />
      <circle cx="22.8" cy="11.2" r="3.1" />
      <path d="M12.3 11.2h7.4M8 5.2l1.1-2.5h13.8L24 5.2" />
    </svg>
  )
}

function ExitGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  )
}

export const CardboardViewer = forwardRef<
  CardboardViewerHandle,
  CardboardViewerProps
>(function CardboardViewer(
  {
    scenes,
    initialSceneId,
    ariaLabel = 'Cardboard panoramic memory',
    onActiveChange,
    onSceneChange,
    onExit,
  },
  forwardedRef,
) {
  const rootRef = useRef<HTMLElement>(null)
  const leftViewerRef = useRef<PanoramaViewerHandle>(null)
  const rightViewerRef = useRef<PanoramaViewerHandle>(null)
  const exitButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const callbacksRef = useRef({ onActiveChange, onSceneChange, onExit })
  const activeRef = useRef(false)
  const sessionRef = useRef(0)
  const fullscreenOwnedRef = useRef(false)
  const permissionRef = useRef<CardboardMotionPermission>('not-required')
  const motionAttemptedRef = useRef(false)
  const resolvedInitialSceneId = resolveInitialSceneId(scenes, initialSceneId)
  const currentSceneIdRef = useRef(resolvedInitialSceneId)

  const [active, setActive] = useState(false)
  const [leftReady, setLeftReady] = useState(false)
  const [rightReady, setRightReady] = useState(false)
  const [permission, setPermission] = useState<
    CardboardMotionPermission | 'checking'
  >('not-required')
  const [motionStatus, setMotionStatus] = useState<MotionStatus>('idle')
  const [fullscreenAvailable, setFullscreenAvailable] = useState(true)
  const [portrait, setPortrait] = useState(isPortraitViewport)
  const [currentSceneId, setCurrentSceneId] = useState(resolvedInitialSceneId)

  useEffect(() => {
    callbacksRef.current = { onActiveChange, onSceneChange, onExit }
  }, [onActiveChange, onExit, onSceneChange])

  useEffect(() => {
    const nextSceneId = resolveInitialSceneId(scenes, initialSceneId)
    const currentStillExists = scenes.some(
      ({ id }) => id === currentSceneIdRef.current,
    )
    if (activeRef.current && currentStillExists) return

    currentSceneIdRef.current = nextSceneId
    setCurrentSceneId(nextSceneId)
  }, [initialSceneId, scenes])

  const stopBothViewers = useCallback(() => {
    leftViewerRef.current?.stopOrientation()
    rightViewerRef.current?.stopOrientation()
  }, [])

  const startBothViewers = useCallback(async () => {
    const leftViewer = leftViewerRef.current
    const rightViewer = rightViewerRef.current
    if (!activeRef.current || !leftViewer || !rightViewer) return

    const requestedSession = sessionRef.current
    motionAttemptedRef.current = true
    setMotionStatus('starting')

    const results = await Promise.allSettled([
      leftViewer.startOrientation(),
      rightViewer.startOrientation(),
    ])
    if (
      !activeRef.current ||
      requestedSession !== sessionRef.current
    ) {
      return
    }

    const activeViewCount = results.filter(
      (result) => result.status === 'fulfilled' && result.value,
    ).length
    setMotionStatus(
      activeViewCount === 2
        ? 'active'
        : activeViewCount === 1
          ? 'partial'
          : 'unavailable',
    )
  }, [])

  const exit = useCallback(async () => {
    if (!activeRef.current) return

    activeRef.current = false
    sessionRef.current += 1
    stopBothViewers()
    unlockOrientation()
    setActive(false)
    setLeftReady(false)
    setRightReady(false)
    setMotionStatus('idle')
    callbacksRef.current.onActiveChange?.(false)

    const ownedFullscreen = fullscreenOwnedRef.current
    fullscreenOwnedRef.current = false
    await leaveOwnedFullscreen(rootRef.current, ownedFullscreen)
    callbacksRef.current.onExit?.()

    window.requestAnimationFrame(() => {
      previousFocusRef.current?.focus({ preventScroll: true })
      previousFocusRef.current = null
    })
  }, [stopBothViewers])

  const enter = useCallback(async (): Promise<CardboardEntryResult> => {
    if (activeRef.current) {
      return {
        fullscreen: fullscreenOwnedRef.current,
        motionPermission: permissionRef.current,
      }
    }

    const requestedSession = ++sessionRef.current
    activeRef.current = true
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    motionAttemptedRef.current = false
    setLeftReady(false)
    setRightReady(false)
    setMotionStatus('preparing')
    setPermission('checking')
    setFullscreenAvailable(true)
    setPortrait(isPortraitViewport())
    setActive(true)
    callbacksRef.current.onActiveChange?.(true)

    // Both calls begin inside the originating click. This is important for
    // fullscreen and for iOS' user-gesture-gated motion permission prompt.
    const permissionRequest = requestMotionPermission()
    const fullscreenRequest = rootRef.current
      ? requestElementFullscreen(rootRef.current)
      : Promise.resolve(false)
    const [motionPermission, fullscreen] = await Promise.all([
      permissionRequest,
      fullscreenRequest,
    ])

    if (
      !activeRef.current ||
      requestedSession !== sessionRef.current
    ) {
      return { fullscreen, motionPermission }
    }

    permissionRef.current = motionPermission
    fullscreenOwnedRef.current = fullscreen
    setPermission(motionPermission)
    setFullscreenAvailable(fullscreen)
    if (motionPermission === 'denied') setMotionStatus('denied')
    if (fullscreen) void lockLandscape()

    return { fullscreen, motionPermission }
  }, [])

  useImperativeHandle(
    forwardedRef,
    () => ({ enter, exit }),
    [enter, exit],
  )

  useEffect(() => {
    if (
      !active ||
      !leftReady ||
      !rightReady ||
      permission === 'checking' ||
      motionAttemptedRef.current
    ) {
      return
    }

    if (permission === 'denied') return

    void startBothViewers()
  }, [active, leftReady, permission, rightReady, startBothViewers])

  useEffect(() => {
    if (!active) return

    const root = rootRef.current
    const updatePortrait = () => setPortrait(isPortraitViewport())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void exit()
    }
    const handleFullscreenChange = () => {
      if (
        activeRef.current &&
        fullscreenOwnedRef.current &&
        currentFullscreenElement() !== root
      ) {
        void exit()
      }
    }
    const portraitQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(orientation: portrait)')
        : undefined

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', updatePortrait)
    window.addEventListener('orientationchange', updatePortrait)
    portraitQuery?.addEventListener?.('change', updatePortrait)

    const previousOverflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    const focusFrame = window.requestAnimationFrame(() => {
      exitButtonRef.current?.focus({ preventScroll: true })
      leftViewerRef.current?.resize()
      rightViewerRef.current?.resize()
    })

    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener(
        'webkitfullscreenchange',
        handleFullscreenChange,
      )
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', updatePortrait)
      window.removeEventListener('orientationchange', updatePortrait)
      portraitQuery?.removeEventListener?.('change', updatePortrait)
      document.documentElement.style.overflow = previousOverflow
      if (activeRef.current) stopBothViewers()
    }
  }, [active, exit, stopBothViewers])

  const retryMotion = useCallback(async () => {
    if (!activeRef.current) return

    // startOrientation is invoked before this handler yields so Safari can
    // associate its permission request with the Enable motion button press.
    permissionRef.current = 'not-required'
    setPermission('not-required')
    motionAttemptedRef.current = false
    await startBothViewers()
  }, [startBothViewers])

  const handleSceneChange = useCallback(
    (nextSceneId: string) => {
      if (
        nextSceneId === currentSceneIdRef.current ||
        !scenes.some(({ id }) => id === nextSceneId)
      ) {
        return
      }

      currentSceneIdRef.current = nextSceneId
      setCurrentSceneId(nextSceneId)
      callbacksRef.current.onSceneChange?.(nextSceneId)
    },
    [scenes],
  )

  if (typeof document === 'undefined') return null

  return createPortal(
    <section
      ref={rootRef}
      className={`ks-cardboard${active ? ' ks-cardboard--active' : ''}`}
      role="dialog"
      aria-modal={active ? true : undefined}
      aria-label={ariaLabel}
      aria-hidden={!active}
      inert={!active ? true : undefined}
    >
      {active ? (
        <>
          <div className="ks-cardboard__eyes" aria-label="Synchronized split view">
            <div className="ks-cardboard__eye ks-cardboard__eye--left">
              <PanoramaViewer
                ref={leftViewerRef}
                scenes={scenes}
                initialSceneId={currentSceneId}
                sceneId={currentSceneId}
                ariaLabel={`${ariaLabel}, left eye`}
                showControls={false}
                onReady={() => setLeftReady(true)}
                onSceneChange={handleSceneChange}
              />
              <span className="ks-cardboard__reticle" aria-hidden="true" />
            </div>

            <div
              className="ks-cardboard__eye ks-cardboard__eye--right"
              aria-hidden="true"
              inert
            >
              <PanoramaViewer
                ref={rightViewerRef}
                scenes={scenes}
                initialSceneId={currentSceneId}
                sceneId={currentSceneId}
                ariaLabel={`${ariaLabel}, right eye`}
                showControls={false}
                onReady={() => setRightReady(true)}
                onSceneChange={handleSceneChange}
              />
              <span className="ks-cardboard__reticle" aria-hidden="true" />
            </div>
          </div>

          <div className="ks-cardboard__brand" aria-hidden="true">
            <CardboardGlyph />
            <span>Cardboard preview</span>
          </div>

          <button
            ref={exitButtonRef}
            type="button"
            className="ks-cardboard__exit"
            onClick={() => void exit()}
            aria-label="Exit Cardboard view"
          >
            <ExitGlyph />
            <span>Exit</span>
          </button>

          <div className="ks-cardboard__status-panel">
            <p role="status" aria-live="polite">
              {MOTION_MESSAGES[motionStatus]}
            </p>
            {motionStatus === 'denied' ||
            motionStatus === 'partial' ||
            motionStatus === 'unavailable' ? (
              <button type="button" onClick={() => void retryMotion()}>
                Enable motion
              </button>
            ) : null}
            {!fullscreenAvailable ? (
              <small>
                Fullscreen is unavailable, so the immersive overlay is being used.
              </small>
            ) : null}
          </div>

          {portrait ? (
            <div className="ks-cardboard__rotate-hint" role="status">
              <span className="ks-cardboard__phone" aria-hidden="true" />
              <strong>Rotate your phone</strong>
              <span>Use landscape before placing it in Cardboard.</span>
            </div>
          ) : null}

          <p className="ks-cardboard__accessible-instructions">
            Cardboard split view shows the same monoscopic panorama in two
            synchronized viewports and uses the phone motion sensors when
            available. It is not a WebXR session. Remove the headset and use the
            Exit button or Escape key to leave.
          </p>
        </>
      ) : null}
    </section>,
    document.body,
  )
})
