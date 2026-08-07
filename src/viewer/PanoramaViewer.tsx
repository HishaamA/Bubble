import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPannellumAdapter } from './PannellumAdapter'
import type {
  PanoramaAdapter,
  PanoramaHotSpot,
  PanoramaOrientationStartOptions,
  PanoramaScene,
  PanoramaView,
  PanoramaViewState,
} from './types'
import './PanoramaViewer.css'

export interface PanoramaViewerHandle {
  changeScene: (sceneId: string, view?: PanoramaView) => boolean
  getView: () => PanoramaViewState | null
  setView: (view: PanoramaViewState) => boolean
  startOrientation: (
    options?: PanoramaOrientationStartOptions,
  ) => Promise<boolean>
  stopOrientation: () => void
  resize: () => void
  destroy: () => void
}

export interface PanoramaViewerProps {
  scenes: readonly PanoramaScene[]
  initialSceneId?: string
  sceneId?: string
  initialView?: PanoramaView
  className?: string
  style?: CSSProperties
  ariaLabel?: string
  showControls?: boolean
  pointSelectionEnabled?: boolean
  onPointSelect?: (point: Pick<PanoramaViewState, 'pitch' | 'yaw'>) => void
  onPointSelectionCancel?: () => void
  onReady?: () => void
  onSceneChange?: (sceneId: string) => void
  onError?: (error: Error) => void
}

type ViewerStatus = 'loading' | 'ready' | 'error'

const KEYBOARD_PAN_STEP = 8

function IconZoomIn() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function IconZoomOut() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  )
}

function IconMotion() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7.75" y="3.25" width="8.5" height="17.5" rx="2" />
      <path d="M4.3 8.3 2.5 12l1.8 3.7M19.7 8.3l1.8 3.7-1.8 3.7" />
    </svg>
  )
}

function IconPanorama() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 6.5c5.7-2 11.3-2 17 0v11c-5.7 2-11.3 2-17 0z" />
      <path d="m4 16 4.2-4.2 3 2.6 3.5-4.2 5.1 5.4" />
    </svg>
  )
}

function joinClassNames(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(' ')
}

export const PanoramaViewer = forwardRef<
  PanoramaViewerHandle,
  PanoramaViewerProps
>(function PanoramaViewer(
  {
    scenes,
    initialSceneId,
    sceneId,
    initialView,
    className,
    style,
    ariaLabel = 'Interactive panoramic memory',
    showControls = true,
    pointSelectionEnabled = false,
    onPointSelect,
    onPointSelectionCancel,
    onReady,
    onSceneChange,
    onError,
  },
  forwardedRef,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<PanoramaAdapter | undefined>(undefined)
  const callbacksRef = useRef({ onReady, onSceneChange, onError })
  const requestedSceneIdRef = useRef(sceneId)
  const componentActiveRef = useRef(false)
  const motionRequestVersionRef = useRef(0)
  const pointPointerRef = useRef<{
    id: number
    x: number
    y: number
  } | null>(null)
  const hotspotListHeadingId = useId()

  const firstSceneId = initialSceneId ?? scenes[0]?.id
  const [currentSceneId, setCurrentSceneId] = useState(
    sceneId ?? firstSceneId ?? '',
  )
  const [status, setStatus] = useState<ViewerStatus>('loading')
  const [flatMode, setFlatMode] = useState(false)
  const [motionSupported, setMotionSupported] = useState(false)
  const [motionActive, setMotionActive] = useState(false)
  const [motionPending, setMotionPending] = useState(false)
  const [motionNotice, setMotionNotice] = useState<string | null>(null)

  const currentScene =
    scenes.find(({ id }) => id === currentSceneId) ?? scenes[0]

  useEffect(() => {
    callbacksRef.current = { onReady, onSceneChange, onError }
  }, [onError, onReady, onSceneChange])

  useEffect(() => {
    componentActiveRef.current = true
    return () => {
      componentActiveRef.current = false
    }
  }, [])

  useEffect(() => {
    requestedSceneIdRef.current = sceneId
  }, [sceneId])

  const stopMotion = useCallback(() => {
    motionRequestVersionRef.current += 1
    adapterRef.current?.stopOrientation()
    setMotionActive(false)
    setMotionPending(false)
  }, [])

  const startMotion = useCallback(async (
    options?: PanoramaOrientationStartOptions,
  ): Promise<boolean> => {
    const adapter = adapterRef.current
    if (!adapter || !adapter.isOrientationSupported()) return false
    const requestedMotion = ++motionRequestVersionRef.current

    setMotionPending(true)
    setMotionNotice(null)

    let started = false
    try {
      started = await adapter.startOrientation(options)
    } catch {
      started = false
    }

    if (
      !componentActiveRef.current ||
      adapterRef.current !== adapter ||
      requestedMotion !== motionRequestVersionRef.current
    ) {
      return false
    }

    const actuallyActive = started && adapter.isOrientationActive()
    setMotionActive(actuallyActive)
    setMotionPending(false)
    if (!actuallyActive) {
      setMotionNotice(
        'Motion access was not granted. Drag the panorama to look around.',
      )
    }
    return actuallyActive
  }, [])

  useImperativeHandle(
    forwardedRef,
    () => ({
      changeScene: (nextSceneId, view) =>
        adapterRef.current?.changeScene(nextSceneId, view) ?? false,
      getView: () => adapterRef.current?.getView() ?? null,
      setView: (view) => adapterRef.current?.setView(view) ?? false,
      startOrientation: startMotion,
      stopOrientation: stopMotion,
      resize: () => adapterRef.current?.resize(),
      destroy: () => {
        motionRequestVersionRef.current += 1
        adapterRef.current?.destroy()
        setMotionActive(false)
        setMotionPending(false)
      },
    }),
    [startMotion, stopMotion],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container || scenes.length === 0) return

    const adapter = createPannellumAdapter()
    adapterRef.current = adapter
    let effectActive = true
    motionRequestVersionRef.current += 1
    setStatus('loading')
    setMotionSupported(false)
    setMotionActive(false)
    setMotionPending(false)
    setMotionNotice(null)

    void adapter
      .mount(container, {
        scenes,
        initialSceneId: requestedSceneIdRef.current ?? firstSceneId,
        initialView,
        onLoad: () => {
          if (!effectActive) return
          setStatus('ready')
          setMotionSupported(adapter.isOrientationSupported())
          callbacksRef.current.onReady?.()
        },
        onSceneChange: (nextSceneId) => {
          if (!effectActive) return
          setMotionActive(false)
          setCurrentSceneId(nextSceneId)
          callbacksRef.current.onSceneChange?.(nextSceneId)
        },
        onError: (error) => {
          if (!effectActive) return
          setStatus('error')
          setFlatMode(true)
          setMotionActive(false)
          callbacksRef.current.onError?.(error)
        },
      })
      .catch((error: unknown) => {
        if (!effectActive) return
        const viewerError =
          error instanceof Error
            ? error
            : new Error('The panorama could not be displayed.')
        setStatus('error')
        setFlatMode(true)
        setMotionActive(false)
        callbacksRef.current.onError?.(viewerError)
      })

    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => adapter.resize())
    observer?.observe(container)

    return () => {
      effectActive = false
      observer?.disconnect()
      adapter.destroy()
      if (adapterRef.current === adapter) adapterRef.current = undefined
    }
  }, [firstSceneId, initialView, scenes])

  useEffect(() => {
    if (status !== 'ready' || !sceneId || sceneId === currentSceneId) return
    if (adapterRef.current?.changeScene(sceneId)) setCurrentSceneId(sceneId)
  }, [currentSceneId, sceneId, status])

  const selectFlatScene = (nextSceneId: string) => {
    setCurrentSceneId(nextSceneId)
    const interactiveSceneChanged =
      adapterRef.current?.changeScene(nextSceneId) ?? false
    if (!interactiveSceneChanged) {
      callbacksRef.current.onSceneChange?.(nextSceneId)
    }
  }

  const toggleMotion = () => {
    if (motionActive) {
      stopMotion()
      setMotionNotice(null)
      return
    }
    void startMotion()
  }

  const handleViewerKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (
      flatMode ||
      status !== 'ready' ||
      event.target !== event.currentTarget
    ) {
      return
    }

    const adapter = adapterRef.current
    if (!adapter) return

    if (pointSelectionEnabled && event.key === 'Escape') {
      event.preventDefault()
      onPointSelectionCancel?.()
      return
    }

    if (
      pointSelectionEnabled &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      const view = adapter.getView()
      if (view) onPointSelect?.({ pitch: view.pitch, yaw: view.yaw })
      event.preventDefault()
      return
    }

    switch (event.key) {
      case 'ArrowUp':
        adapter.panBy(KEYBOARD_PAN_STEP, 0)
        setMotionActive(false)
        break
      case 'ArrowDown':
        adapter.panBy(-KEYBOARD_PAN_STEP, 0)
        setMotionActive(false)
        break
      case 'ArrowLeft':
        adapter.panBy(0, -KEYBOARD_PAN_STEP)
        setMotionActive(false)
        break
      case 'ArrowRight':
        adapter.panBy(0, KEYBOARD_PAN_STEP)
        setMotionActive(false)
        break
      case '+':
      case '=':
        adapter.zoomIn()
        break
      case '-':
      case '_':
        adapter.zoomOut()
        break
      default:
        return
    }

    event.preventDefault()
  }

  const beginPointSelection = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (motionActive) stopMotion()
    if (
      !pointSelectionEnabled ||
      !event.isPrimary ||
      event.button !== 0
    ) {
      return
    }

    pointPointerRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    }
  }

  const finishPointSelection = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const start = pointPointerRef.current
    pointPointerRef.current = null
    if (
      !pointSelectionEnabled ||
      !start ||
      start.id !== event.pointerId ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8
    ) {
      return
    }

    const point = adapterRef.current?.getCoordinatesFromEvent(
      event.nativeEvent as MouseEvent,
    )
    if (point) onPointSelect?.(point)
  }

  const activateFlatHotSpot = (
    hotSpot: PanoramaHotSpot,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    hotSpot.onActivate?.(event.nativeEvent)
    if (
      hotSpot.kind === 'scene' &&
      hotSpot.sceneId &&
      scenes.some(({ id }) => id === hotSpot.sceneId)
    ) {
      selectFlatScene(hotSpot.sceneId)
    }
  }

  const toggleFlatMode = () => {
    if (!flatMode) {
      stopMotion()
      setFlatMode(true)
      return
    }

    setFlatMode(false)
    queueMicrotask(() => {
      adapterRef.current?.resize()
      containerRef.current?.focus()
    })
  }

  if (!currentScene) {
    return (
      <section
        className={joinClassNames('ks-panorama', className)}
        style={style}
        aria-label={ariaLabel}
      >
        <p className="ks-panorama__empty">No panoramic memories yet.</p>
      </section>
    )
  }

  return (
    <section
      className={joinClassNames(
        'ks-panorama',
        flatMode && 'ks-panorama--flat',
        pointSelectionEnabled && 'ks-panorama--selecting-point',
        className,
      )}
      style={style}
      aria-label={ariaLabel}
    >
      <div
        ref={containerRef}
        className="ks-panorama__canvas"
        tabIndex={flatMode ? -1 : 0}
        inert={flatMode ? true : undefined}
        aria-hidden={flatMode ? true : undefined}
        aria-label={`${ariaLabel}. Use arrow keys to look around and plus or minus to zoom.`}
        aria-keyshortcuts={
          flatMode ? undefined : 'ArrowUp ArrowDown ArrowLeft ArrowRight + -'
        }
        onKeyDown={handleViewerKeyDown}
        onPointerDown={beginPointSelection}
        onPointerUp={finishPointSelection}
        onPointerCancel={() => {
          pointPointerRef.current = null
        }}
      />

      {flatMode ? (
        <figure className="ks-panorama__fallback">
          <img src={currentScene.panorama} alt={currentScene.alt} />
          <figcaption>
            {currentScene.title && <strong>{currentScene.title}</strong>}
            {currentScene.description && <span>{currentScene.description}</span>}
          </figcaption>
          {scenes.length > 1 && (
            <label className="ks-panorama__scene-picker">
              <span>Memory</span>
              <select
                value={currentScene.id}
                onChange={(event) => selectFlatScene(event.target.value)}
              >
                {scenes.map((scene) => (
                  <option key={scene.id} value={scene.id}>
                    {scene.title ?? scene.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(currentScene.hotSpots?.length ?? 0) > 0 && (
            <section
              className="ks-panorama__hotspot-actions"
              aria-labelledby={hotspotListHeadingId}
            >
              <h2 id={hotspotListHeadingId}>Memory points</h2>
              <ul>
                {currentScene.hotSpots?.map((hotSpot) => {
                  const linkedSceneExists =
                    hotSpot.kind === 'scene' &&
                    scenes.some(({ id }) => id === hotSpot.sceneId)
                  const actionable =
                    Boolean(hotSpot.onActivate) || linkedSceneExists
                  const actionKind =
                    hotSpot.kind === 'audio'
                      ? 'Voice note'
                      : hotSpot.kind === 'scene'
                        ? 'Linked panorama'
                        : 'Memory note'

                  return (
                    <li key={hotSpot.id}>
                      <button
                        type="button"
                        onClick={(event) =>
                          activateFlatHotSpot(hotSpot, event)
                        }
                        disabled={!actionable}
                      >
                        <span>{hotSpot.label}</span>
                        <small>{actionKind}</small>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </figure>
      ) : (
        <div className="ks-panorama__instructions">
          {pointSelectionEnabled
            ? 'Tap the object where this memory point belongs.'
            : 'Drag to look around. Pinch or use the controls to zoom.'}
        </div>
      )}

      {status === 'loading' && !flatMode && (
        <div className="ks-panorama__status" role="status">
          <span className="ks-panorama__spinner" aria-hidden="true" />
          Opening memory…
        </div>
      )}

      {status === 'error' && (
        <p className="ks-panorama__notice" role="status">
          Interactive view unavailable. Showing the accessible image instead.
        </p>
      )}

      {motionNotice && !flatMode && (
        <p className="ks-panorama__motion-notice" role="status">
          {motionNotice}
        </p>
      )}

      {showControls && (
        <div
          className="ks-panorama__controls"
          role="group"
          aria-label="Panorama controls"
        >
          {!flatMode && (
            <>
              <button
                type="button"
                onClick={() => adapterRef.current?.zoomIn()}
                aria-label="Zoom in"
                disabled={status !== 'ready'}
              >
                <IconZoomIn />
              </button>
              <button
                type="button"
                onClick={() => adapterRef.current?.zoomOut()}
                aria-label="Zoom out"
                disabled={status !== 'ready'}
              >
                <IconZoomOut />
              </button>
              <button
                type="button"
                className={motionActive ? 'is-active' : undefined}
                onClick={toggleMotion}
                aria-label={
                  motionActive ? 'Turn motion control off' : 'Turn motion control on'
                }
                aria-pressed={motionActive}
                aria-busy={motionPending}
                disabled={
                  status !== 'ready' || !motionSupported || motionPending
                }
                title={
                  motionPending
                    ? 'Waiting for motion permission'
                    : motionSupported
                    ? 'Look around by moving your phone'
                    : 'Motion control is unavailable on this device'
                }
              >
                <IconMotion />
              </button>
            </>
          )}
          <button
            type="button"
            className={flatMode ? 'is-active' : undefined}
            onClick={toggleFlatMode}
            aria-label={
              flatMode ? 'Return to interactive panorama' : 'View as a flat image'
            }
            aria-pressed={flatMode}
            disabled={status === 'error'}
          >
            <IconPanorama />
          </button>
        </div>
      )}
    </section>
  )
})
