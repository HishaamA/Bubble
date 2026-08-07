import {
  useEffect,
  useLayoutEffect,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { formatLocalDay, toLocalIsoDate } from '../../lib/appDate'
import { Capture360Shortcut } from '../capture'
import { calculateBubbleMotion } from './bubbleMotion'
import {
  calculateCenterDepth,
  calculateConstellationPan,
  calculateInitialConstellationPan,
} from './constellationSpace'
import { MemoryBubble } from './MemoryBubble'
import { memories, type Memory } from './memories'
import { SharedMomentBubble } from './SharedMomentBubble'
import type { PanoramaMoment } from './shared'

type MemoryConstellationProps = {
  sharedMoments?: PanoramaMoment[]
  onUpload360?: () => void
  now?: Date
}

export function MemoryConstellation({
  sharedMoments = [],
  onUpload360,
  now = new Date(),
}: MemoryConstellationProps = {}) {
  const navigate = useNavigate()
  const location = useLocation()
  const restoreMemoryId = (location.state as { restoreMemoryId?: string } | null)
    ?.restoreMemoryId
  const newestSharedMoment = sharedMoments[0]
  const constellationMemories = newestSharedMoment
    ? memories.filter(({ id }) => id !== 'sunset')
    : memories
  const entryCandidateIds = [
    ...constellationMemories.map(({ id }) => id),
    ...(newestSharedMoment?.objectUrl
      ? [`shared-${newestSharedMoment.id}`]
      : []),
  ]
  const fieldRef = useRef<HTMLDivElement>(null)
  const spaceRef = useRef<HTMLDivElement>(null)
  const entryMemoryIdRef = useRef<string | null>(null)
  if (entryMemoryIdRef.current === null) {
    const requestedMemoryExists = restoreMemoryId
      ? entryCandidateIds.includes(restoreMemoryId) ||
        restoreMemoryId.startsWith('shared-')
      : false
    if (requestedMemoryExists) {
      entryMemoryIdRef.current = restoreMemoryId ?? null
    } else if (entryCandidateIds.length > 0) {
      const randomIndex = Math.min(
        entryCandidateIds.length - 1,
        Math.floor(Math.random() * entryCandidateIds.length),
      )
      entryMemoryIdRef.current = entryCandidateIds[randomIndex] ?? null
    }
  }
  const animationFrameRef = useRef<number | null>(null)
  const pointerRef = useRef({
    x: 0,
    y: 0,
    pressed: false,
    visible: false,
  })
  const panRef = useRef({ x: 0, y: 0 })
  const initialPanRef = useRef({ x: 0, y: 0 })
  const panInitializedRef = useRef(false)
  const panStartRef = useRef({ x: 0, y: 0 })
  const activePointerRef = useRef<number | null>(null)
  const pointerCaptureTargetRef = useRef<HTMLElement | null>(null)
  const dragStartRef = useRef({ x: 0, y: 0 })
  const draggedRef = useRef(false)
  const hasExploredRef = useRef(true)
  const suppressNextPointerClickRef = useRef(false)
  const suppressResetTimerRef = useRef<number | null>(null)
  const reducedMotionRef = useRef(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    if (!restoreMemoryId) return

    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`memory-${restoreMemoryId}`)?.focus({ preventScroll: true })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [restoreMemoryId])

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
      if (suppressResetTimerRef.current !== null) {
        window.clearTimeout(suppressResetTimerRef.current)
        suppressResetTimerRef.current = null
      }
    },
    [],
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handlePreferenceChange = (event: MediaQueryListEvent) => {
      reducedMotionRef.current = event.matches
      clearPointerInteraction()
    }

    preference.addEventListener?.('change', handlePreferenceChange)
    return () => preference.removeEventListener?.('change', handlePreferenceChange)
  }, [])

  useLayoutEffect(() => {
    // Run once before paint so a routed return to Moments never flashes the
    // old equal-sized layout. The animation-frame and observer paths below
    // remain as fallbacks for a view transition that temporarily measures 0px.
    renderBubbleMotion()
  }, [newestSharedMoment?.id])

  useEffect(() => {
    scheduleRender()
    const field = fieldRef.current
    if (!field || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(scheduleRender)
    observer.observe(field)
    if (spaceRef.current) observer.observe(spaceRef.current)
    return () => observer.disconnect()
  }, [])

  function scheduleRender() {
    if (animationFrameRef.current === null) {
      animationFrameRef.current = window.requestAnimationFrame(renderBubbleMotion)
    }
  }

  function clearPointerInteraction() {
    const field = fieldRef.current
    if (!field) return

    pointerRef.current.pressed = false
    pointerRef.current.visible = false
    field.dataset.pointerVisible = 'false'
    field.dataset.interacting = 'false'
    field.dataset.panning = 'false'
    scheduleRender()
  }

  function renderBubbleMotion() {
    animationFrameRef.current = null
    const field = fieldRef.current
    const space = spaceRef.current
    if (!field || !space) return

    const pointer = pointerRef.current
    const width = field.clientWidth
    const height = field.clientHeight
    const worldWidth = space.clientWidth
    const worldHeight = space.clientHeight
    if (width <= 0 || height <= 0 || worldWidth <= 0 || worldHeight <= 0) {
      return
    }

    const bubbleElements = Array.from(
      field.querySelectorAll<HTMLElement>('.memory-bubble'),
    )

    if (!panInitializedRef.current) {
      const centerableBubbles = bubbleElements.filter(
        (bubble) => Math.max(bubble.offsetWidth, bubble.offsetHeight) > 0,
      )
      let entryBubble = entryMemoryIdRef.current
        ? centerableBubbles.find(
            (bubble) =>
              bubble.dataset.memoryId === entryMemoryIdRef.current,
          )
        : undefined

      // A restored/shared item can arrive one render later, and test/browser
      // layout engines can briefly report a chosen item as 0px. Keep the entry
      // experience alive by centering the first measurable bubble for this pass.
      if (!entryBubble) {
        entryBubble = centerableBubbles[0]
        entryMemoryIdRef.current = entryBubble?.dataset.memoryId ?? null
      }

      if (entryBubble) {
        const bubbleSize = Math.max(
          entryBubble.offsetWidth,
          entryBubble.offsetHeight,
        )
        panRef.current = calculateConstellationPan({
          origin: { x: 0, y: 0 },
          delta: {
            x: width / 2 - (entryBubble.offsetLeft + bubbleSize / 2),
            y: height / 2 - (entryBubble.offsetTop + bubbleSize / 2),
          },
          field: { width, height },
          world: { width: worldWidth, height: worldHeight },
        })
        hasExploredRef.current = true
      } else {
        panRef.current = calculateInitialConstellationPan({
          field: { width, height },
          world: { width: worldWidth, height: worldHeight },
        })
      }

      panStartRef.current = { ...panRef.current }
      initialPanRef.current = { ...panRef.current }
      panInitializedRef.current = true
    }
    const pan = panRef.current

    field.style.setProperty('--constellation-pan-x', `${pan.x}px`)
    field.style.setProperty('--constellation-pan-y', `${pan.y}px`)
    field.style.setProperty('--thumb-x', `${pointer.x}px`)
    field.style.setProperty('--thumb-y', `${pointer.y}px`)
    field.dataset.pointerVisible = pointer.visible ? 'true' : 'false'
    field.dataset.interacting = pointer.pressed
      ? 'true'
      : pointer.visible
        ? 'hover'
        : 'false'
    field.dataset.panning = pointer.pressed && draggedRef.current ? 'true' : 'false'
    field.dataset.spaceMoved =
      pan.x !== initialPanRef.current.x || pan.y !== initialPanRef.current.y
        ? 'true'
        : 'false'

    const renderedBubbles: Array<{
      bubble: HTMLElement
      motionElement: HTMLElement
      centerScale: number
      centerProximity: number
      centerDistance: number
      motion: { x: number; y: number; scale: number; proximity: number }
    }> = []

    bubbleElements.forEach((bubble, order) => {
      const size = Math.max(bubble.offsetWidth, bubble.offsetHeight)
      const motionElement = bubble.querySelector<HTMLElement>('.memory-bubble__motion')
      if (!motionElement) return
      const geometry = {
        x: bubble.offsetLeft,
        y: bubble.offsetTop,
        size,
      }
      const centerDepth = calculateCenterDepth({
        field: { width, height },
        bubble: geometry,
        pan,
      })
      const motion =
        pointer.visible && !draggedRef.current && !reducedMotionRef.current
          ? calculateBubbleMotion({
              pointer,
              field: { width, height },
              bubble: {
                ...geometry,
                x: geometry.x + pan.x,
                y: geometry.y + pan.y,
              },
              order,
              pressed: pointer.pressed,
            })
          : { x: 0, y: 0, scale: 1, proximity: 0 }
      renderedBubbles.push({
        bubble,
        motionElement,
        centerScale: centerDepth.scale,
        centerProximity: centerDepth.proximity,
        centerDistance: centerDepth.distance,
        motion,
      })
    })

    const focusedBubble = hasExploredRef.current
      ? renderedBubbles.reduce<(typeof renderedBubbles)[number] | null>(
          (closest, candidate) =>
            !closest || candidate.centerDistance < closest.centerDistance
              ? candidate
              : closest,
          null,
        )
      : null

    renderedBubbles.forEach(
      ({ bubble, motionElement, centerScale, centerProximity, motion }) => {
        const displayedScale = hasExploredRef.current ? centerScale : 1
        const displayedProximity = hasExploredRef.current
          ? centerProximity
          : 0.35
        motionElement.style.setProperty('--bubble-shift-x', `${motion.x}px`)
        motionElement.style.setProperty('--bubble-shift-y', `${motion.y}px`)
        motionElement.style.setProperty(
          '--bubble-center-scale',
          `${displayedScale}`,
        )
        motionElement.style.setProperty(
          '--bubble-motion-scale',
          `${displayedScale * motion.scale}`,
        )
        motionElement.style.setProperty('--bubble-energy', `${motion.proximity}`)
        motionElement.style.setProperty('--bubble-depth', `${displayedProximity}`)
        bubble.dataset.centerFocus =
          focusedBubble?.bubble === bubble ? 'true' : 'false'
        bubble.dataset.depth =
          displayedProximity > 0.68
            ? 'near'
            : displayedProximity > 0.18
              ? 'middle'
              : 'far'
      },
    )
    field.dataset.layoutReady = 'true'
  }

  function scheduleBubbleMotion(
    event: ReactPointerEvent<HTMLDivElement>,
    pressed: boolean,
    visible = true,
  ) {
    const field = fieldRef.current
    if (!field) return
    const rect = field.getBoundingClientRect()
    const width = field.clientWidth
    const height = field.clientHeight
    const scaleX = rect.width > 0 ? width / rect.width : 1
    const scaleY = rect.height > 0 ? height / rect.height : 1
    pointerRef.current = {
      x: Math.min(width, Math.max(0, (event.clientX - rect.left) * scaleX)),
      y: Math.min(height, Math.max(0, (event.clientY - rect.top) * scaleY)),
      pressed,
      visible,
    }

    scheduleRender()
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return
    if (activePointerRef.current !== null) return

    activePointerRef.current = event.pointerId
    dragStartRef.current = { x: event.clientX, y: event.clientY }
    panStartRef.current = { ...panRef.current }
    draggedRef.current = false

    const eventTarget = event.target as HTMLElement
    const captureTarget = eventTarget.closest<HTMLElement>('.memory-bubble') ?? fieldRef.current
    pointerCaptureTargetRef.current = captureTarget
    if (captureTarget && typeof captureTarget.setPointerCapture === 'function') {
      try {
        captureTarget.setPointerCapture(event.pointerId)
      } catch {
        pointerCaptureTargetRef.current = null
      }
    }

    scheduleBubbleMotion(event, true)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const isActive = activePointerRef.current === event.pointerId
    if (event.pointerType !== 'mouse' && !isActive) return

    if (isActive) {
      const delta = {
        x: event.clientX - dragStartRef.current.x,
        y: event.clientY - dragStartRef.current.y,
      }
      const travel = Math.hypot(delta.x, delta.y)
      if (travel > 8) {
        draggedRef.current = true
        hasExploredRef.current = true
        const field = fieldRef.current
        if (field) {
          const space = spaceRef.current
          if (!space) return
          panRef.current = calculateConstellationPan({
            origin: panStartRef.current,
            delta,
            field: { width: field.clientWidth, height: field.clientHeight },
            world: { width: space.clientWidth, height: space.clientHeight },
          })
        }
        event.preventDefault()
      }
    }

    scheduleBubbleMotion(event, isActive)
  }

  function finishPointerInteraction(event: ReactPointerEvent<HTMLDivElement>) {
    if (activePointerRef.current !== event.pointerId) return
    if (draggedRef.current) armPointerClickSuppression()
    activePointerRef.current = null

    const captureTarget = pointerCaptureTargetRef.current
    pointerCaptureTargetRef.current = null
    if (captureTarget && typeof captureTarget.releasePointerCapture === 'function') {
      try {
        captureTarget.releasePointerCapture(event.pointerId)
      } catch {
        // Pointer capture may already have been released by the browser.
      }
    }

    if (event.pointerType === 'mouse') scheduleBubbleMotion(event, false)
    else clearPointerInteraction()
  }

  function handleLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>) {
    if (activePointerRef.current !== event.pointerId) return
    if (draggedRef.current) armPointerClickSuppression()
    activePointerRef.current = null
    pointerCaptureTargetRef.current = null
    clearPointerInteraction()
  }

  function centerFocusedBubble(event: ReactFocusEvent<HTMLDivElement>) {
    if (activePointerRef.current !== null) return
    const target = event.target as HTMLElement
    const bubble = target.closest<HTMLElement>('.memory-bubble')
    const field = fieldRef.current
    const space = spaceRef.current
    if (!bubble || !field || !space) return

    hasExploredRef.current = true

    const fieldSize = { width: field.clientWidth, height: field.clientHeight }
    const worldSize = { width: space.clientWidth, height: space.clientHeight }
    const bubbleSize = Math.max(bubble.offsetWidth, bubble.offsetHeight)
    if (
      fieldSize.width <= 0 ||
      fieldSize.height <= 0 ||
      worldSize.width <= 0 ||
      worldSize.height <= 0 ||
      bubbleSize <= 0
    ) {
      return
    }

    if (!panInitializedRef.current) {
      initialPanRef.current = calculateInitialConstellationPan({
        field: fieldSize,
        world: worldSize,
      })
      panInitializedRef.current = true
    }

    panRef.current = calculateConstellationPan({
      origin: { x: 0, y: 0 },
      delta: {
        x: fieldSize.width / 2 - (bubble.offsetLeft + bubbleSize / 2),
        y: fieldSize.height / 2 - (bubble.offsetTop + bubbleSize / 2),
      },
      field: fieldSize,
      world: worldSize,
    })
    panStartRef.current = { ...panRef.current }
    scheduleRender()
  }

  function armPointerClickSuppression() {
    suppressNextPointerClickRef.current = true
    if (suppressResetTimerRef.current !== null) {
      window.clearTimeout(suppressResetTimerRef.current)
    }
    suppressResetTimerRef.current = window.setTimeout(() => {
      suppressNextPointerClickRef.current = false
      suppressResetTimerRef.current = null
    }, 450)
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

  return (
    <section className="memories-screen" aria-labelledby="moments-title">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Our family</p>
          <h1 id="moments-title">Moments</h1>
          <time className="moments-date" dateTime={toLocalIsoDate(now)}>
            {formatLocalDay(now)}
          </time>
        </div>
        <button
          className="round-control"
          type="button"
          aria-label="Set up Cardboard VR"
          onClick={() =>
            navigate('/memory/dinner', {
              state: { sourceMemoryId: 'dinner', openVr: true },
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
        aria-describedby="memory-explore-instructions"
        data-interacting="false"
        data-pointer-visible="false"
        data-panning="false"
        data-space-moved="false"
        data-layout-ready="false"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerInteraction}
        onPointerCancel={finishPointerInteraction}
        onLostPointerCapture={handleLostPointerCapture}
        onFocusCapture={centerFocusedBubble}
        onContextMenu={(event) => event.preventDefault()}
        onDragStart={(event) => event.preventDefault()}
        onPointerLeave={(event) => {
          if (activePointerRef.current !== null) return
          if (event.pointerType === 'mouse') clearPointerInteraction()
        }}
      >
        <div className="memory-constellation__thumb-glow" aria-hidden="true" />
        <div className="memory-constellation__glow" aria-hidden="true" />
        <div
          ref={spaceRef}
          className="memory-constellation__space"
          data-testid="memory-constellation-space"
        >
          {constellationMemories.map((memory, order) => (
            <MemoryBubble
              key={memory.id}
              memory={memory}
              order={order}
              entryFocused={entryMemoryIdRef.current === memory.id}
              onOpen={openMemory}
            />
          ))}
          {newestSharedMoment ? (
            <SharedMomentBubble
              moment={newestSharedMoment}
              order={constellationMemories.length}
              entryFocused={
                entryMemoryIdRef.current === `shared-${newestSharedMoment.id}`
              }
              onOpen={openSharedMoment}
            />
          ) : null}
        </div>
      </div>

      {onUpload360 ? (
        <Capture360Shortcut onClick={onUpload360} />
      ) : null}

      <p id="memory-explore-instructions" className="screen-reader-only">
        One memory is brought forward when Moments opens. Drag or swipe to explore the memory space. The memory nearest the center grows larger. Use Tab to center each memory, then select one to open its panoramic view.
      </p>
    </section>
  )
}
