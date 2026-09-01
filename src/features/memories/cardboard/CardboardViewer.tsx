import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { Capacitor } from '@capacitor/core'
import { createPortal } from 'react-dom'
import type { PanoramaScene } from '../../../viewer'
import './CardboardViewer.css'
import {
  StereoPanoramaRenderer,
  type StereoPanoramaRendererHandle,
} from './StereoPanoramaRenderer'
import {
  nativeCardboardOrientationAvailable,
  requestNativeCardboardLandscape,
  restoreNativeAppOrientation,
  shouldRequestCardboardDomFullscreenFallback,
} from './nativeCardboardOrientation'
import { useLandscapeOrientation } from './useLandscapeOrientation'

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

export interface CardboardEntryOptions {
  forceLandscape?: boolean
}

export interface CardboardViewerHandle {
  /** Call directly from the VR button's click handler to preserve user activation. */
  enter: (options?: CardboardEntryOptions) => Promise<CardboardEntryResult>
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

const MOTION_FALLBACK_MESSAGES: Partial<Record<MotionStatus, string>> = {
  unavailable:
    'Motion tracking could not start. Leave and re-enter VR to retry; synchronized drag is still available.',
  denied:
    'Motion access is off. Allow Motion & Orientation Access, then leave and re-enter VR.',
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
  // Fullscreen is shared browser state. Only unwind the exact element this
  // session successfully promoted, otherwise leaving VR could collapse a
  // fullscreen surface owned by another feature or a newer Cardboard session.
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

function focusableDialogControls(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(
    (element) =>
      !element.hasAttribute('hidden') &&
      element.getAttribute('aria-hidden') !== 'true',
  )
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
  const stereoViewerRef = useRef<StereoPanoramaRendererHandle>(null)
  const exitButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const callbacksRef = useRef({ onActiveChange, onSceneChange, onExit })
  const mountedRef = useRef(true)
  const activeRef = useRef(false)
  const sessionRef = useRef(0)
  const entryPromiseRef = useRef<Promise<CardboardEntryResult> | null>(null)
  const exitPromiseRef = useRef<Promise<void> | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  const settleResizeTimersRef = useRef<number[]>([])
  const motionActiveRef = useRef(false)
  const viewerGenerationRef = useRef(0)
  const mountedScenesRef = useRef(scenes)
  const fullscreenRootRef = useRef<HTMLElement | null>(null)
  const fullscreenOwnedRef = useRef(false)
  const permissionRef = useRef<CardboardMotionPermission>('not-required')
  const motionAttemptedRef = useRef(false)
  const landscape = useLandscapeOrientation()
  const resolvedInitialSceneId = resolveInitialSceneId(scenes, initialSceneId)
  const currentSceneIdRef = useRef(resolvedInitialSceneId)

  const [active, setActive] = useState(false)
  const [readyScenes, setReadyScenes] = useState<
    readonly PanoramaScene[] | null
  >(null)
  const [permission, setPermission] = useState<
    CardboardMotionPermission | 'checking'
  >('not-required')
  const [motionStatus, setMotionStatus] = useState<MotionStatus>('idle')
  const [fullscreenAvailable, setFullscreenAvailable] = useState(true)
  const [presentationReady, setPresentationReady] = useState(false)
  const [landscapeOverride, setLandscapeOverride] = useState(false)
  const [currentSceneId, setCurrentSceneId] = useState(resolvedInitialSceneId)
  const viewerReady = readyScenes === scenes
  const activeScene =
    scenes.find(({ id }) => id === currentSceneId) ?? scenes[0]
  const forceLandscape = active && landscapeOverride && !landscape
  const motionFallbackMessage = MOTION_FALLBACK_MESSAGES[motionStatus]
  const androidWebFallback =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

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

  const stopStereoViewer = useCallback(() => {
    motionActiveRef.current = false
    stereoViewerRef.current?.stopOrientation()
  }, [])

  const resizeStereoViewer = useCallback(() => {
    stereoViewerRef.current?.resize()
  }, [])

  const scheduleSettledViewerResizes = useCallback(() => {
    settleResizeTimersRef.current.forEach(window.clearTimeout)
    settleResizeTimersRef.current = [0, 100, 300].map((delay) =>
      window.setTimeout(() => {
        resizeStereoViewer()
      }, delay),
    )
  }, [resizeStereoViewer])

  useEffect(() => {
    if (mountedScenesRef.current === scenes) return
    mountedScenesRef.current = scenes
    if (!activeRef.current) return

    // PanoramaViewer remounts its adapter when the scene objects refresh (for
    // example, when a shared blob URL is replaced). Reset the parent readiness
    // gate too, otherwise the old "attempted" flag prevents gyro reattachment.
    viewerGenerationRef.current += 1
    motionAttemptedRef.current = false
    setReadyScenes(null)
    stopStereoViewer()
    setMotionStatus('preparing')
  }, [scenes, stopStereoViewer])

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      activeRef.current = false
      sessionRef.current += 1
      entryPromiseRef.current = null
      stopStereoViewer()
      unlockOrientation()

      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current)
        focusFrameRef.current = null
      }
      settleResizeTimersRef.current.forEach(window.clearTimeout)
      settleResizeTimersRef.current = []

      const fullscreenRoot = fullscreenRootRef.current
      const ownedFullscreen = fullscreenOwnedRef.current
      fullscreenOwnedRef.current = false
      fullscreenRootRef.current = null
      void leaveOwnedFullscreen(fullscreenRoot, ownedFullscreen)
      void restoreNativeAppOrientation()
    }
  }, [stopStereoViewer])

  const startPrimaryViewer = useCallback(async (
    permissionAlreadyGranted = false,
  ) => {
    const stereoViewer = stereoViewerRef.current
    if (!activeRef.current || !stereoViewer) return

    const requestedSession = sessionRef.current
    const requestedViewerGeneration = viewerGenerationRef.current
    motionAttemptedRef.current = true
    motionActiveRef.current = false
    setMotionStatus('starting')

    // One listener feeds one full yaw / pitch / roll pose into one WebGL frame,
    // which is then drawn into both eye viewports without inter-eye drift.
    let started = false
    try {
      started = await stereoViewer.startOrientation({ permissionAlreadyGranted })
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

  const handleTrackingStateChange = useCallback(
    (state: 'waiting' | 'active' | 'stale') => {
      if (!activeRef.current || state === 'waiting') return
      const activeTracking = state === 'active'
      motionActiveRef.current = activeTracking
      setMotionStatus(activeTracking ? 'active' : 'unavailable')
    },
    [],
  )

  const exit = useCallback((): Promise<void> => {
    if (exitPromiseRef.current) return exitPromiseRef.current
    if (!activeRef.current) return Promise.resolve()

    activeRef.current = false
    sessionRef.current += 1
    entryPromiseRef.current = null
    stopStereoViewer()
    unlockOrientation()
    if (mountedRef.current) {
      setActive(false)
      setReadyScenes(null)
      setPermission('not-required')
      setMotionStatus('idle')
      setLandscapeOverride(false)
      setPresentationReady(false)
    }
    settleResizeTimersRef.current.forEach(window.clearTimeout)
    settleResizeTimersRef.current = []
    permissionRef.current = 'not-required'

    // Leave the synthetic panorama host route immediately. Native orientation
    // restoration can finish a moment later on iPhone and must never keep the
    // user stranded on the underlying Sunday dinner memory. Restoration is
    // still awaited by the handle so a caller that needs stable portrait
    // geometry can await exit(), while the visible route is not held hostage.
    callbacksRef.current.onActiveChange?.(false)
    callbacksRef.current.onExit?.()

    const ownedFullscreen = fullscreenOwnedRef.current
    const fullscreenRoot = fullscreenRootRef.current ?? rootRef.current
    fullscreenOwnedRef.current = false
    const exitPromise = Promise.all([
      leaveOwnedFullscreen(fullscreenRoot, ownedFullscreen),
      restoreNativeAppOrientation(),
    ]).then(() => {
      if (fullscreenRootRef.current === fullscreenRoot) {
        fullscreenRootRef.current = null
      }
      if (!mountedRef.current) return
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
  }, [stopStereoViewer])

  const enter = useCallback(function enterCardboardViewer(
    options: CardboardEntryOptions = {},
  ): Promise<CardboardEntryResult> {
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
      setReadyScenes(null)
      setMotionStatus('preparing')
      setPermission('checking')
      setFullscreenAvailable(true)
      setPresentationReady(false)
      setLandscapeOverride(options.forceLandscape === true)
      setActive(true)
    }
    callbacksRef.current.onActiveChange?.(true)

    // These calls begin inside the originating click because browser fullscreen,
    // native rotation and iOS motion permission all consume the same transient
    // user activation. iOS uses the native bridge without DOM fullscreen;
    // Android asks for both because an installed bridge can exist while its
    // immersive flags fail, and the web build relies on DOM fullscreen alone.
    const nativeOrientationCapable = nativeCardboardOrientationAvailable()
    const nativeDomFullscreenFallback =
      shouldRequestCardboardDomFullscreenFallback()
    const nativeOrientationRequest = requestNativeCardboardLandscape()
    const permissionRequest = requestMotionPermission()
    const fullscreenRequest =
      (!nativeOrientationCapable || nativeDomFullscreenFallback) && fullscreenRoot
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
      if (!nativeOrientationCapable) setFullscreenAvailable(fullscreen)
      if (fullscreen) {
        await lockLandscape()
        if (!activeRef.current || !mountedRef.current) {
          unlockOrientation()
        }
      }
      return fullscreen
    })

    const settledNativeOrientation = nativeOrientationRequest.then(
      async (requested) => {
        const entryIsCurrent =
          activeRef.current &&
          requestedSession === sessionRef.current &&
          mountedRef.current

        if (!entryIsCurrent && requested) {
          const newerSessionNeedsLandscape =
            activeRef.current && requestedSession !== sessionRef.current
          if (!newerSessionNeedsLandscape) {
            await restoreNativeAppOrientation()
          }
        }

        if (entryIsCurrent && nativeOrientationCapable) {
          setFullscreenAvailable(requested || fullscreenOwnedRef.current)
        }

        return requested
      },
    )

    const entryPromise = Promise.all([
      settledPermission,
      settledFullscreen,
      settledNativeOrientation,
    ]).then(([motionPermission, fullscreen, nativePresentation]) => {
      if (
        activeRef.current &&
        requestedSession === sessionRef.current &&
        mountedRef.current
      ) {
        setPresentationReady(true)
        scheduleSettledViewerResizes()
      }
      return {
        fullscreen: fullscreen || nativePresentation,
        motionPermission,
      }
    }).finally(() => {
      if (entryPromiseRef.current === entryPromise) {
        entryPromiseRef.current = null
      }
    })
    entryPromiseRef.current = entryPromise
    return entryPromise
  }, [scheduleSettledViewerResizes])

  useImperativeHandle(
    forwardedRef,
    () => ({ enter, exit }),
    [enter, exit],
  )

  useEffect(() => {
    if (
      !active ||
      !viewerReady ||
      !presentationReady ||
      permission === 'checking' ||
      motionAttemptedRef.current
    ) {
      return
    }

    if (permission !== 'granted' && permission !== 'not-required') return

    void startPrimaryViewer(permission === 'granted')
  }, [active, permission, presentationReady, startPrimaryViewer, viewerReady])

  useEffect(() => {
    if (!active) return

    const root = rootRef.current
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void exit()
        return
      }
      if (event.key !== 'Tab' || !root) return

      // The viewer is portalled outside the inert app viewport. Explicitly
      // cycle its controls so a hardware-keyboard user cannot tab into browser
      // chrome or another portal while the modal headset surface owns input.
      const controls = focusableDialogControls(root)
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) return
      const focused = document.activeElement
      if (event.shiftKey && (focused === first || !root.contains(focused))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (focused === last || !root.contains(focused))) {
        event.preventDefault()
        first.focus()
      }
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
    const restoreAppViewport = makeAppViewportInert()

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    window.addEventListener('keydown', handleKeyDown)

    const previousOverflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null
      exitButtonRef.current?.focus({ preventScroll: true })
      stereoViewerRef.current?.resize()
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
      document.documentElement.style.overflow = previousOverflow
      restoreAppViewport()
    }
  }, [active, exit])

  useEffect(() => {
    if (!active) return
    let frame: number | null = null
    const scheduleResize = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        resizeStereoViewer()
      })
    }
    window.addEventListener('resize', scheduleResize)
    window.addEventListener('orientationchange', scheduleResize)
    window.visualViewport?.addEventListener('resize', scheduleResize)
    scheduleResize()
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', scheduleResize)
      window.removeEventListener('orientationchange', scheduleResize)
      window.visualViewport?.removeEventListener('resize', scheduleResize)
    }
  }, [active, forceLandscape, landscape, resizeStereoViewer, viewerReady])

  const useSplitViewAnyway = useCallback(() => {
    setLandscapeOverride(true)
    window.requestAnimationFrame(() => {
      resizeStereoViewer()
      exitButtonRef.current?.focus({ preventScroll: true })
    })
  }, [resizeStereoViewer])

  if (typeof document === 'undefined') return null

  return createPortal(
    <section
      ref={rootRef}
      className={`ks-cardboard${active ? ' ks-cardboard--active' : ''}${forceLandscape ? ' ks-cardboard--forced-landscape' : ''}${androidWebFallback ? ' ks-cardboard--android-fallback' : ''}`}
      role="dialog"
      aria-modal={active ? true : undefined}
      aria-label={ariaLabel}
      aria-hidden={!active}
      inert={!active ? true : undefined}
      data-view-mode="dual-lens"
    >
      {active ? (
        <>
          <div className="ks-cardboard__eyes" aria-label="Synchronized split view">
            {activeScene ? (
              <StereoPanoramaRenderer
                ref={stereoViewerRef}
                scene={activeScene}
                ariaLabel={`${ariaLabel}, synchronized left and right eye panorama`}
                opticalCenterShift={0}
                viewportProfile={
                  androidWebFallback ? 'youtube-fallback' : 'ios-reference'
                }
                horizontalFovOverride={androidWebFallback ? 80 : undefined}
                onReady={() => setReadyScenes(scenes)}
                onTrackingStateChange={handleTrackingStateChange}
              />
            ) : (
              <p className="ks-cardboard__missing-scene" role="alert">
                This panorama is unavailable.
              </p>
            )}

            <div className="ks-cardboard__eye ks-cardboard__eye--left">
              <div className="ks-cardboard__memory-label" aria-hidden="true">
                <strong>{activeScene?.title ?? 'Family moment'}</strong>
                {memoryByline ? <span>{memoryByline}</span> : null}
              </div>
              <span className="ks-cardboard__reticle" aria-hidden="true" />
            </div>

            <div
              className="ks-cardboard__eye ks-cardboard__eye--right"
              aria-hidden="true"
            >
              <div className="ks-cardboard__memory-label" aria-hidden="true">
                <strong>{activeScene?.title ?? 'Family moment'}</strong>
                {memoryByline ? <span>{memoryByline}</span> : null}
              </div>
              <span className="ks-cardboard__reticle" aria-hidden="true" />
            </div>

            <span className="ks-cardboard__nose-bridge" aria-hidden="true" />
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

          {motionFallbackMessage || !fullscreenAvailable ? (
            <div className="ks-cardboard__status-pair">
              {[false, true].map((visualClone) => (
                <div
                  key={visualClone ? 'right' : 'left'}
                  className="ks-cardboard__status-panel"
                  aria-hidden={visualClone ? true : undefined}
                >
                  {motionFallbackMessage ? (
                    <p
                      role={visualClone ? undefined : 'status'}
                      aria-live={visualClone ? undefined : 'polite'}
                    >
                      {motionFallbackMessage}
                    </p>
                  ) : null}
                  {!fullscreenAvailable ? (
                    <small>
                      Fullscreen is unavailable, so the immersive overlay is
                      being used.
                    </small>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {!landscape && !landscapeOverride ? (
            <div
              className="ks-cardboard__rotate-hint"
              role="group"
              aria-labelledby="ks-cardboard-rotate-title"
              aria-describedby="ks-cardboard-rotate-description"
            >
              <span className="ks-cardboard__phone" aria-hidden="true" />
              <strong id="ks-cardboard-rotate-title">Rotate your phone</strong>
              <span id="ks-cardboard-rotate-description">Use landscape before placing it in Cardboard.</span>
              <button type="button" onClick={useSplitViewAnyway}>Use split view anyway</button>
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
