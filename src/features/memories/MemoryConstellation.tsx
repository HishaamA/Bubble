import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Capture360Shortcut } from '../capture'
import { calculateBubbleMotion } from './bubbleMotion'
import { MemoryBubble } from './MemoryBubble'
import { memories, type Memory } from './memories'
import { SharedMomentBubble } from './SharedMomentBubble'
import type { PanoramaMoment } from './shared'

type MemoryConstellationProps = {
  sharedMoments?: PanoramaMoment[]
  onUpload360?: () => void
}

export function MemoryConstellation({
  sharedMoments = [],
  onUpload360,
}: MemoryConstellationProps = {}) {
  const navigate = useNavigate()
  const location = useLocation()
  const fieldRef = useRef<HTMLDivElement>(null)
  const animationFrameRef = useRef<number | null>(null)
  const pointerRef = useRef({ x: 0, y: 0, pressed: false })
  const activePointerRef = useRef<number | null>(null)
  const dragStartRef = useRef({ x: 0, y: 0 })
  const draggedRef = useRef(false)
  const suppressNextPointerClickRef = useRef(false)
  const suppressResetTimerRef = useRef<number | null>(null)
  const reducedMotionRef = useRef(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    const restoreMemoryId = (location.state as { restoreMemoryId?: string } | null)
      ?.restoreMemoryId
    if (!restoreMemoryId) return

    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`memory-${restoreMemoryId}`)?.focus({ preventScroll: true })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [location.state])

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
      }
      if (suppressResetTimerRef.current !== null) {
        window.clearTimeout(suppressResetTimerRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handlePreferenceChange = (event: MediaQueryListEvent) => {
      reducedMotionRef.current = event.matches
      if (event.matches) resetBubbleMotion()
    }

    preference.addEventListener?.('change', handlePreferenceChange)
    return () => preference.removeEventListener?.('change', handlePreferenceChange)
  }, [])

  function resetBubbleMotion() {
    const field = fieldRef.current
    if (!field) return

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    field.dataset.pointerVisible = 'false'
    field.dataset.interacting = 'false'
    field.querySelectorAll<HTMLElement>('.memory-bubble__motion').forEach((motion) => {
      motion.style.setProperty('--bubble-shift-x', '0px')
      motion.style.setProperty('--bubble-shift-y', '0px')
      motion.style.setProperty('--bubble-motion-scale', '1')
      motion.style.setProperty('--bubble-energy', '0')
    })
  }

  function renderBubbleMotion() {
    animationFrameRef.current = null
    const field = fieldRef.current
    if (!field || reducedMotionRef.current) return

    const pointer = pointerRef.current
    const width = field.clientWidth
    const height = field.clientHeight
    if (width <= 0 || height <= 0) return

    field.style.setProperty('--thumb-x', `${pointer.x}px`)
    field.style.setProperty('--thumb-y', `${pointer.y}px`)
    field.dataset.pointerVisible = 'true'
    field.dataset.interacting = pointer.pressed ? 'true' : 'hover'

    field.querySelectorAll<HTMLElement>('.memory-bubble').forEach((bubble, order) => {
      const size = Math.max(bubble.offsetWidth, bubble.offsetHeight)
      const motionElement = bubble.querySelector<HTMLElement>('.memory-bubble__motion')
      if (!motionElement) return
      const motion = calculateBubbleMotion({
        pointer,
        field: { width, height },
        bubble: { x: bubble.offsetLeft, y: bubble.offsetTop, size },
        order,
        pressed: pointer.pressed,
      })

      motionElement.style.setProperty('--bubble-shift-x', `${motion.x}px`)
      motionElement.style.setProperty('--bubble-shift-y', `${motion.y}px`)
      motionElement.style.setProperty('--bubble-motion-scale', `${motion.scale}`)
      motionElement.style.setProperty('--bubble-energy', `${motion.proximity}`)
    })
  }

  function scheduleBubbleMotion(
    event: ReactPointerEvent<HTMLDivElement>,
    pressed: boolean,
  ) {
    const field = fieldRef.current
    if (!field || reducedMotionRef.current) return
    const rect = field.getBoundingClientRect()
    const width = field.clientWidth
    const height = field.clientHeight
    const scaleX = rect.width > 0 ? width / rect.width : 1
    const scaleY = rect.height > 0 ? height / rect.height : 1
    pointerRef.current = {
      x: Math.min(width, Math.max(0, (event.clientX - rect.left) * scaleX)),
      y: Math.min(height, Math.max(0, (event.clientY - rect.top) * scaleY)),
      pressed,
    }

    if (animationFrameRef.current === null) {
      animationFrameRef.current = window.requestAnimationFrame(renderBubbleMotion)
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || reducedMotionRef.current) return
    activePointerRef.current = event.pointerId
    dragStartRef.current = { x: event.clientX, y: event.clientY }
    draggedRef.current = false
    scheduleBubbleMotion(event, true)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const isActive = activePointerRef.current === event.pointerId
    if (event.pointerType !== 'mouse' && !isActive) return

    if (isActive) {
      const travel = Math.hypot(
        event.clientX - dragStartRef.current.x,
        event.clientY - dragStartRef.current.y,
      )
      if (travel > 8) draggedRef.current = true
    }

    scheduleBubbleMotion(event, isActive)
  }

  function finishPointerInteraction(event: ReactPointerEvent<HTMLDivElement>) {
    if (activePointerRef.current !== event.pointerId) return
    if (draggedRef.current) armPointerClickSuppression()
    activePointerRef.current = null

    if (event.pointerType === 'mouse') scheduleBubbleMotion(event, false)
    else resetBubbleMotion()
  }

  function armPointerClickSuppression() {
    suppressNextPointerClickRef.current = true
    if (suppressResetTimerRef.current !== null) {
      window.clearTimeout(suppressResetTimerRef.current)
    }
    suppressResetTimerRef.current = window.setTimeout(() => {
      suppressNextPointerClickRef.current = false
      suppressResetTimerRef.current = null
    }, 0)
  }

  function openMemory(memory: Memory, event: ReactMouseEvent<HTMLButtonElement>) {
    if (suppressNextPointerClickRef.current && event.detail > 0) {
      suppressNextPointerClickRef.current = false
      if (suppressResetTimerRef.current !== null) {
        window.clearTimeout(suppressResetTimerRef.current)
        suppressResetTimerRef.current = null
      }
      return
    }
    suppressNextPointerClickRef.current = false
    navigate(`/memory/${memory.id}`, {
      state: { sourceMemoryId: memory.id },
      viewTransition: true,
    })
  }

  function openSharedMoment(
    moment: PanoramaMoment,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    if (suppressNextPointerClickRef.current && event.detail > 0) {
      suppressNextPointerClickRef.current = false
      return
    }
    navigate(`/memory/shared-${moment.id}`, {
      state: { sourceMemoryId: `shared-${moment.id}` },
      viewTransition: true,
    })
  }

  const newestSharedMoment = sharedMoments[0]
  const constellationMemories = newestSharedMoment
    ? memories.filter(({ id }) => id !== 'sunset')
    : memories

  return (
    <section className="memories-screen" aria-labelledby="memories-title">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Family circle</p>
          <h1 id="memories-title">KinSphere</h1>
        </div>
        <button
          className="round-control"
          type="button"
          aria-label="Cardboard panorama shortcut"
          onClick={() =>
            navigate('/memory/dinner', {
              state: { sourceMemoryId: 'dinner' },
              viewTransition: true,
            })
          }
        >
          <Icon name="vr" size={24} />
        </button>
      </header>

      <div
        ref={fieldRef}
        className="memory-constellation"
        aria-label="Family memory constellation"
        data-interacting="false"
        data-pointer-visible="false"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerInteraction}
        onPointerCancel={finishPointerInteraction}
        onPointerLeave={() => {
          if (activePointerRef.current !== null && draggedRef.current) {
            armPointerClickSuppression()
          }
          activePointerRef.current = null
          resetBubbleMotion()
        }}
      >
        <div className="memory-constellation__glow" aria-hidden="true" />
        <div className="memory-constellation__thumb-glow" aria-hidden="true" />
        {constellationMemories.map((memory, order) => (
          <MemoryBubble
            key={memory.id}
            memory={memory}
            order={order}
            onOpen={openMemory}
          />
        ))}
        {newestSharedMoment ? (
          <SharedMomentBubble
            moment={newestSharedMoment}
            order={constellationMemories.length}
            onOpen={openSharedMoment}
          />
        ) : null}
      </div>

      {onUpload360 ? (
        <Capture360Shortcut onClick={onUpload360} />
      ) : null}

      <p className="screen-reader-only" aria-live="polite">
        Select a memory to open its panoramic view.
      </p>
    </section>
  )
}
