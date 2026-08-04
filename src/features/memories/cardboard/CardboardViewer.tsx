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
  | 'insecure'
  | 'unsupported'

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
  memoryByline?: string
  onActiveChange?: (active: boolean) => void
  onSceneChange?: (sceneId: string) => void
  onExit?: () => void
}

type MotionStatus =
  | 'idle'
  | 'preparing'
  | 'starting'
  | 'active'
  | 'manual'
  | 'unavailable'
  | 'denied'
  | 'insecure'
  | 'unsupported'

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

type InertSnapshot = {
  element: HTMLElement
  attributeValue: string | null
}

const MOTION_MESSAGES: Record<MotionStatus, string> = {
  idle: 'Motion tracking is ready to begin.',
  preparing: 'Preparing the Cardboard view…',
  starting: 'Starting phone motion tracking…',
  active: 'Motion tracking active. Both eyes move together.',
  manual: 'Manual look-around active. Drag either view, or enable motion again.',
  unavailable:
    'Motion tracking is unavailable. You can still drag either view to look around.',
  denied:
    'Motion access was not granted. Use Enable motion to try again.',
  insecure:
    'Phone motion needs HTTPS or the installed app. This HTTP page still supports synchronized drag.',
  unsupported:
    'This browser does not expose phone motion sensors. Synchronized drag is still available.',
}

function isNativeAppProtocol(protocol: string): boolean {
  return protocol === 'capacitor:' || protocol === 'ionic:'
}

function isLocalDevelopmentHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  )
}

function isTrustedMotionContext(): boolean {
  if (typeof window === 'undefined') return false
  const { protocol, hostname } = window.location
  if (isNativeAppProtocol(protocol)) return true
  if (typeof window.isSecureContext === 'boolean') {
    return window.isSecureContext
  }
  return protocol === 'https:' || isLocalDevelopmentHost(hostname)
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
  if (!isTrustedMotionContext()) return 'insecure'

  const orientationEvent = globalThis.DeviceOrientationEvent as
    | PermissionCapableDeviceOrientationEvent
    | undefined
  if (!orientationEvent) return 'unsupported'
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
  if (currentFullscreenElement() === element) return true
  if (currentFullscreenElement()) return false

  const fullscreenElement = element as WebkitFullscreenElement
  const request =
    element.requestFullscreen ?? fullscreenElement.webkitRequestFullscreen

  if (!request) return false

  try {
    await request.call(element)
    return currentFullscreenElement() === element
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
  if (!currentElement || currentElement !== root) return

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

function makeAppViewportInert(): () => void {
  const snapshots: InertSnapshot[] = Array.from(
    document.querySelectorAll<HTMLElement>('.app-viewport'),
    (element) => ({
      element,
      attributeValue: element.getAttribute('inert'),
    }),
  )

  snapshots.forEach(({ element }) => element.setAttribute('inert', ''))

  return () => {
    snapshots.forEach(({ element, attributeValue }) => {
      if (attributeValue === null) {
        element.removeAttribute('inert')
      } else {
        element.setAttribute('inert', attributeValue)
      }
    })
  }
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
    memoryByline,
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
  const mountedRef = useRef(true)
  const activeRef = useRef(false)
  const sessionRef = useRef(0)
  const entryPromiseRef = useRef<Promise<CardboardEntryResult> | null>(null)
  const exitPromiseRef = useRef<Promise<void> | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  const syncFrameRef = useRef<number | null>(null)
  const syncSourceRef = useRef<'left' | 'right'>('left')
  const motionActiveRef = useRef(false)
  const viewerGenerationRef = useRef(0)
  const mountedScenesRef = useRef(scenes)
  const fullscreenRootRef = useRef<HTMLElement | null>(null)
  const fullscreenOwnedRef = useRef(false)
  const permissionRef = useRef<CardboardMotionPermission>('not-required')
  const motionAttemptedRef = useRef(false)
  const resolvedInitialSceneId = resolveInitialSceneId(scenes, initialSceneId)
  const currentSceneIdRef = useRef(resolvedInitialSceneId)

  const [active, setActive] = useState(false)
  const [leftReadyScenes, setLeftReadyScenes] = useState<
    readonly PanoramaScene[] | null
  >(null)
  const [rightReadyScenes, setRightReadyScenes] = useState<
    readonly PanoramaScene[] | null
  >(null)
  const [permission, setPermission] = useState<
    CardboardMotionPermission | 'checking'
  >('not-required')
  const [motionStatus, setMotionStatus] = useState<MotionStatus>('idle')
  const [fullscreenAvailable, setFullscreenAvailable] = useState(true)
  const [portrait, setPortrait] = useState(isPortraitViewport)
  const [currentSceneId, setCurrentSceneId] = useState(resolvedInitialSceneId)
  const leftReady = leftReadyScenes === scenes
  const rightReady = rightReadyScenes === scenes
  const activeScene =
    scenes.find(({ id }) => id === currentSceneId) ?? scenes[0]

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
    motionActiveRef.current = false
    leftViewerRef.current?.stopOrientation()
    rightViewerRef.current?.stopOrientation()
  }, [])

  useEffect(() => {
    if (mountedScenesRef.current === scenes) return
    mountedScenesRef.current = scenes
    if (!activeRef.current) return

    // PanoramaViewer remounts its adapter when the scene objects refresh (for
    // example, when a shared blob URL is replaced). Reset the parent readiness
    // gate too, otherwise the old "attempted" flag prevents gyro reattachment.
    viewerGenerationRef.current += 1
    motionAttemptedRef.current = false
    syncSourceRef.current = 'left'
    stopBothViewers()
    setMotionStatus('preparing')
  }, [scenes, stopBothViewers])

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      activeRef.current = false
      sessionRef.current += 1
      entryPromiseRef.current = null
      stopBothViewers()
      unlockOrientation()

      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current)
        focusFrameRef.current = null
      }
      if (syncFrameRef.current !== null) {
        window.cancelAnimationFrame(syncFrameRef.current)
        syncFrameRef.current = null
      }

      const fullscreenRoot = fullscreenRootRef.current
      const ownedFullscreen = fullscreenOwnedRef.current
      fullscreenOwnedRef.current = false
      fullscreenRootRef.current = null
      void leaveOwnedFullscreen(fullscreenRoot, ownedFullscreen)
    }
  }, [stopBothViewers])

  const startPrimaryViewer = useCallback(async (
    permissionAlreadyGranted = false,
  ) => {
    const leftViewer = leftViewerRef.current
    const rightViewer = rightViewerRef.current
    if (!activeRef.current || !leftViewer || !rightViewer) return

    const requestedSession = sessionRef.current
    const requestedViewerGeneration = viewerGenerationRef.current
    motionAttemptedRef.current = true
    motionActiveRef.current = false
    syncSourceRef.current = 'left'
    setMotionStatus('starting')

    // Only one Pannellum instance owns the deviceorientation listener. Its
    // camera is mirrored into the passive eye every animation frame, avoiding
    // tiny sensor timing differences that otherwise make Cardboard feel split.
    rightViewer.stopOrientation()
    let started = false
    try {
      started = await leftViewer.startOrientation({ permissionAlreadyGranted })
    } catch {
      started = false
    }
    if (
      !activeRef.current ||
      requestedSession !== sessionRef.current ||
      requestedViewerGeneration !== viewerGenerationRef.current
    ) {
      return
    }

    motionActiveRef.current = started
    setMotionStatus(started ? 'active' : 'unavailable')
  }, [])

  const exit = useCallback((): Promise<void> => {
    if (exitPromiseRef.current) return exitPromiseRef.current
    if (!activeRef.current) return Promise.resolve()

    activeRef.current = false
    sessionRef.current += 1
    entryPromiseRef.current = null
    stopBothViewers()
    unlockOrientation()
    if (mountedRef.current) {
      setActive(false)
      setLeftReadyScenes(null)
      setRightReadyScenes(null)
      setPermission('not-required')
      setMotionStatus('idle')
    }
    permissionRef.current = 'not-required'

    const ownedFullscreen = fullscreenOwnedRef.current
    const fullscreenRoot = fullscreenRootRef.current ?? rootRef.current
    fullscreenOwnedRef.current = false
    const exitPromise = leaveOwnedFullscreen(
      fullscreenRoot,
      ownedFullscreen,
    ).then(() => {
      if (fullscreenRootRef.current === fullscreenRoot) {
        fullscreenRootRef.current = null
      }
      if (!mountedRef.current) return
      callbacksRef.current.onActiveChange?.(false)
      callbacksRef.current.onExit?.()
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current)
      }
      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = null
        previousFocusRef.current?.focus({ preventScroll: true })
        previousFocusRef.current = null
      })
    }).finally(() => {
      if (exitPromiseRef.current === exitPromise) {
        exitPromiseRef.current = null
      }
    })
    exitPromiseRef.current = exitPromise
    return exitPromise
  }, [stopBothViewers])

  const enter = useCallback(function enterCardboardViewer(): Promise<CardboardEntryResult> {
    if (entryPromiseRef.current) return entryPromiseRef.current
    if (exitPromiseRef.current) {
      return Promise.reject(
        new Error('Cardboard viewer is still closing. Tap Go again to enter.'),
      )
    }
    if (activeRef.current) {
      return Promise.resolve({
        fullscreen: fullscreenOwnedRef.current,
        motionPermission: permissionRef.current,
      })
    }

    const requestedSession = ++sessionRef.current
    const fullscreenRoot = rootRef.current
    activeRef.current = true
    fullscreenRootRef.current = fullscreenRoot
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    motionAttemptedRef.current = false
    if (mountedRef.current) {
      setLeftReadyScenes(null)
      setRightReadyScenes(null)
      setMotionStatus('preparing')
      setPermission('checking')
      setFullscreenAvailable(true)
      setPortrait(isPortraitViewport())
      setActive(true)
    }
    callbacksRef.current.onActiveChange?.(true)

    // Both calls begin inside the originating click. This is important for
    // fullscreen and for iOS' user-gesture-gated motion permission prompt.
    const permissionRequest = requestMotionPermission()
    const fullscreenRequest = fullscreenRoot
      ? requestElementFullscreen(fullscreenRoot)
      : Promise.resolve(false)

    const settledPermission = permissionRequest.then((motionPermission) => {
      if (
        !activeRef.current ||
        requestedSession !== sessionRef.current ||
        !mountedRef.current
      ) {
        return motionPermission
      }

      permissionRef.current = motionPermission
      setPermission(motionPermission)
      if (motionPermission === 'denied') setMotionStatus('denied')
      if (motionPermission === 'insecure') setMotionStatus('insecure')
      if (motionPermission === 'unsupported') setMotionStatus('unsupported')
      return motionPermission
    })

    const settledFullscreen = fullscreenRequest.then(async (fullscreen) => {
      const entryIsCurrent =
        activeRef.current &&
        requestedSession === sessionRef.current &&
        mountedRef.current

      if (!entryIsCurrent) {
        const newerSessionOwnsFullscreen =
          activeRef.current &&
          requestedSession !== sessionRef.current &&
          fullscreenOwnedRef.current &&
          fullscreenRootRef.current === fullscreenRoot
        if (!newerSessionOwnsFullscreen) {
          await leaveOwnedFullscreen(fullscreenRoot, fullscreen)
        }
        return false
      }

      fullscreenOwnedRef.current = fullscreen
      setFullscreenAvailable(fullscreen)
      if (fullscreen) {
        await lockLandscape()
        if (!activeRef.current || !mountedRef.current) {
          unlockOrientation()
        }
      }
      return fullscreen
    })

    const entryPromise = Promise.all([
      settledPermission,
      settledFullscreen,
    ]).then(([motionPermission, fullscreen]) => ({
      fullscreen,
      motionPermission,
    })).finally(() => {
      if (entryPromiseRef.current === entryPromise) {
        entryPromiseRef.current = null
      }
    })
    entryPromiseRef.current = entryPromise
    return entryPromise
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

    if (permission !== 'granted' && permission !== 'not-required') return

    void startPrimaryViewer(permission === 'granted')
  }, [active, leftReady, permission, rightReady, startPrimaryViewer])

  useEffect(() => {
    if (!active || !leftReady || !rightReady) return

    let cancelled = false
    const mirrorActiveEye = () => {
      if (cancelled || !activeRef.current) return
      const source =
        syncSourceRef.current === 'left'
          ? leftViewerRef.current
          : rightViewerRef.current
      const target =
        syncSourceRef.current === 'left'
          ? rightViewerRef.current
          : leftViewerRef.current
      const view = source?.getView()
      if (view) target?.setView(view)
      syncFrameRef.current = window.requestAnimationFrame(mirrorActiveEye)
    }

    mirrorActiveEye()
    return () => {
      cancelled = true
      if (syncFrameRef.current !== null) {
        window.cancelAnimationFrame(syncFrameRef.current)
        syncFrameRef.current = null
      }
    }
  }, [active, currentSceneId, leftReady, rightReady])

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
    const restoreAppViewport = makeAppViewportInert()

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', updatePortrait)
    window.addEventListener('orientationchange', updatePortrait)
    portraitQuery?.addEventListener?.('change', updatePortrait)

    const previousOverflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null
      exitButtonRef.current?.focus({ preventScroll: true })
      leftViewerRef.current?.resize()
      rightViewerRef.current?.resize()
    })

    return () => {
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current)
        focusFrameRef.current = null
      }
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
      restoreAppViewport()
    }
  }, [active, exit, stopBothViewers])

  const retryMotion = useCallback(async () => {
    if (!activeRef.current) return

    const requestedSession = sessionRef.current
    setPermission('checking')
    setMotionStatus('preparing')
    motionAttemptedRef.current = false
    const motionPermission = await requestMotionPermission()
    if (
      !activeRef.current ||
      requestedSession !== sessionRef.current ||
      !mountedRef.current
    ) {
      return
    }

    permissionRef.current = motionPermission
    setPermission(motionPermission)
    if (
      motionPermission === 'denied' ||
      motionPermission === 'insecure' ||
      motionPermission === 'unsupported'
    ) {
      setMotionStatus(motionPermission)
      return
    }
    await startPrimaryViewer(motionPermission === 'granted')
  }, [startPrimaryViewer])

  const selectSyncSource = useCallback(
    (source: 'left' | 'right') => {
      syncSourceRef.current = source
      if (!motionActiveRef.current) return

      stopBothViewers()
      setMotionStatus('manual')
    },
    [stopBothViewers],
  )

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
            <div
              className="ks-cardboard__eye ks-cardboard__eye--left"
              onPointerDownCapture={() => selectSyncSource('left')}
              onTouchStartCapture={() => selectSyncSource('left')}
            >
              <PanoramaViewer
                ref={leftViewerRef}
                scenes={scenes}
                initialSceneId={currentSceneId}
                sceneId={currentSceneId}
                ariaLabel={`${ariaLabel}, left eye`}
                showControls={false}
                onReady={() => setLeftReadyScenes(scenes)}
                onSceneChange={handleSceneChange}
              />
              <div className="ks-cardboard__memory-label" aria-hidden="true">
                <strong>{activeScene?.title ?? 'Family moment'}</strong>
                {memoryByline ? <span>{memoryByline}</span> : null}
              </div>
              <span className="ks-cardboard__reticle" aria-hidden="true" />
            </div>

            <div
              className="ks-cardboard__eye ks-cardboard__eye--right"
              aria-hidden="true"
              onPointerDownCapture={() => selectSyncSource('right')}
              onTouchStartCapture={() => selectSyncSource('right')}
            >
              <PanoramaViewer
                ref={rightViewerRef}
                scenes={scenes}
                initialSceneId={currentSceneId}
                sceneId={currentSceneId}
                ariaLabel={`${ariaLabel}, right eye`}
                showControls={false}
                onReady={() => setRightReadyScenes(scenes)}
                onSceneChange={handleSceneChange}
              />
              <div className="ks-cardboard__memory-label" aria-hidden="true">
                <strong>{activeScene?.title ?? 'Family moment'}</strong>
                {memoryByline ? <span>{memoryByline}</span> : null}
              </div>
              <span className="ks-cardboard__reticle" aria-hidden="true" />
            </div>
          </div>

          <div className="ks-cardboard__brand" aria-hidden="true">
            <CardboardGlyph />
            <span>KinSphere VR</span>
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
            motionStatus === 'manual' ||
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
            {activeScene?.title ?? 'The selected family memory'} is open.
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
