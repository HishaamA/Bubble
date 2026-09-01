import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  projectGuideTarget,
  STANDARD_GUIDE_TARGETS,
} from './guidedCaptureGeometry'

type GuidedCapturePreviewProps = {
  onClose: () => void
}

export function GuidedCapturePreview({ onClose }: GuidedCapturePreviewProps) {
  const [view, setView] = useState({ yaw: 22.5, pitch: 0 })
  const [captured, setCaptured] = useState<Set<string>>(() => new Set())
  const dragRef = useRef<{
    pointerId: number
    x: number
    y: number
    yaw: number
    pitch: number
  } | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  const projected = useMemo(
    () => STANDARD_GUIDE_TARGETS.map((target) => ({
      target,
      projection: projectGuideTarget(target, view),
    })),
    [view],
  )
  const centralTarget = useMemo(
    () => projected
      .filter(({ target, projection }) =>
        !captured.has(target.id) && projection.visible,
      )
      .sort((left, right) =>
        left.projection.centreDistance - right.projection.centreDistance,
      )[0],
    [captured, projected],
  )
  const holdingTarget = centralTarget && centralTarget.projection.centreDistance <= 0.09
    ? centralTarget.target.id
    : null

  useEffect(() => {
    if (!holdingTarget) return
    const timer = window.setTimeout(() => {
      setCaptured((current) => {
        const next = new Set(current)
        next.add(holdingTarget)
        return next
      })
    }, 620)
    return () => window.clearTimeout(timer)
  }, [holdingTarget])

  const updateFromDevice = useCallback((event: DeviceOrientationEvent) => {
    if (event.alpha === null || event.beta === null) return
    setView({
      yaw: event.alpha,
      pitch: Math.max(-88, Math.min(88, event.beta - 90)),
    })
  }, [])

  useEffect(() => {
    window.addEventListener('deviceorientation', updateFromDevice, true)
    return () => window.removeEventListener('deviceorientation', updateFromDevice, true)
  }, [updateFromDevice])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose])

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      yaw: view.yaw,
      pitch: view.pitch,
    }
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setView({
      yaw: drag.yaw - (event.clientX - drag.x) * 0.28,
      pitch: Math.max(
        -88,
        Math.min(88, drag.pitch + (event.clientY - drag.y) * 0.22),
      ),
    })
  }

  function stopDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }

  return (
    <section
      className="guided-capture"
      role="dialog"
      aria-modal="true"
      aria-label="Guided 360 capture preview"
      onKeyDown={(event) => {
        // The preview has one interactive control. Keeping Tab on that control
        // prevents keyboard focus from escaping behind the modal surface.
        if (event.key !== 'Tab') return
        event.preventDefault()
        closeButtonRef.current?.focus()
      }}
    >
      <div className="guided-capture__topbar">
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close guided capture preview"
        >
          Close
        </button>
        <div>
          <strong>{captured.size} of {STANDARD_GUIDE_TARGETS.length}</strong>
          <span>guide preview</span>
        </div>
        <span aria-hidden="true">360°</span>
      </div>

      <div
        className="guided-capture__field"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        <div className="guided-capture__horizon" aria-hidden="true" />
        {projected.map(({ target, projection }) => (
          <span
            key={target.id}
            className={`guided-capture__dot${captured.has(target.id) ? ' is-captured' : ''}`}
            style={{
              left: `${projection.left}%`,
              top: `${projection.top}%`,
              opacity: projection.visible ? 1 : 0,
              transform: `translate(-50%, -50%) scale(${projection.scale})`,
            }}
            aria-hidden="true"
          />
        ))}
        <span
          className={`guided-capture__reticle${holdingTarget ? ' is-holding' : ''}`}
          aria-hidden="true"
        />
        <p>Move one dot into the centre, then hold still.</p>
      </div>

      <div className="guided-capture__footer">
        <p>
          Drag to preview here. In the installed app, the live camera and phone
          motion move this view, and each steady alignment captures itself.
        </p>
        <div className="guided-capture__progress" aria-hidden="true">
          <span style={{ width: `${(captured.size / STANDARD_GUIDE_TARGETS.length) * 100}%` }} />
        </div>
      </div>
    </section>
  )
}
