import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AppWhimsy } from '../../app/AppWhimsy'
import { formatLocalDay, toLocalIsoDate } from '../../lib/appDate'
import { Capture360Shortcut } from '../capture/Capture360Shortcut'
import { calculateBubbleMotion } from './bubbleMotion'
import {
  constrainBubblePosition,
  normalizeBubblePosition,
  readBubblePlacements,
  saveBubblePlacements,
  type BubblePlacementMap,
} from './bubblePlacement'
import {
  calculateCenterDepth,
  calculateConstellationPan,
  calculateInitialConstellationPan,
} from './constellationSpace'
import { MemoryBubble } from './MemoryBubble'
import { memories, type Memory } from './memories'
import { SharedMomentBubble } from './SharedMomentBubble'
import type { PanoramaMoment } from './shared'
import {
  getSharedMomentPositions,
  getSharedMomentWorldHeightPercent,
} from './sharedMomentLayout'
import './MomentsPlumTheme.css'

type MemoryConstellationProps = {
  sharedMoments?: PanoramaMoment[]
  onUpload360?: () => void
  onDelete360?: (momentId: string) => Promise<void>
  now?: Date
}

const OWNED_MOMENT_HOLD_DELAY_MS = 560
const OWNED_MOMENT_HOLD_CANCEL_DISTANCE_PX = 16
const CONSTELLATION_DRAG_DISTANCE_PX = 8

type PickedBubbleInteraction = {
  element: HTMLElement
  id: string
  label: string
  startClient: { x: number; y: number }
  startPosition: { top: number; left: number }
  currentPosition: { top: number; left: number }
}

export function MemoryConstellation({
  sharedMoments = [],
  onUpload360,
  onDelete360,
  now = new Date(),
}: MemoryConstellationProps = {}) {
  const navigate = useNavigate()
  const location = useLocation()
  const restoreMemoryId = (location.state as { restoreMemoryId?: string } | null)
    ?.restoreMemoryId
  const visibleSharedMoments = sharedMoments.filter(
    (moment): moment is PanoramaMoment & { objectUrl: string } =>
      Boolean(moment.objectUrl),
  )
  const visibleSharedMomentIds = visibleSharedMoments
    .map(({ id }) => id)
    .join(':')
  const constellationSpaceStyle = {
    '--constellation-world-height': `${getSharedMomentWorldHeightPercent(visibleSharedMoments.length)}%`,
  } as CSSProperties
  const sharedMomentPositions = useMemo(
    () => getSharedMomentPositions(visibleSharedMoments.length),
    [visibleSharedMoments.length],
  )
  const constellationMemories = memories
  const entryCandidateIds = [
    ...constellationMemories.map(({ id }) => id),
    ...visibleSharedMoments.map(({ id }) => `shared-${id}`),
  ]
  const fieldRef = useRef<HTMLDivElement>(null)
  const spaceRef = useRef<HTMLDivElement>(null)
  const entryMemoryIdRef = useRef<string | null>(null)
  // Choose the opening bubble exactly once. Recomputing this after an upload or
  // deletion would make the whole constellation jump under the user's finger.
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
  const holdTimerRef = useRef<number | null>(null)
  const longPressActivatedRef = useRef(false)
  const latestPointerClientRef = useRef({ x: 0, y: 0 })
  const pickedBubbleRef = useRef<PickedBubbleInteraction | null>(null)
  const [bubblePlacements, setBubblePlacements] = useState<BubblePlacementMap>(
    readBubblePlacements,
  )
  const bubblePlacementsRef = useRef(bubblePlacements)
  const [pickedUpMemoryId, setPickedUpMemoryId] = useState<string | null>(null)
  const [moveStatus, setMoveStatus] = useState('')
  const [deletionModeMomentId, setDeletionModeMomentId] = useState<
    string | null
  >(null)
  const [deletingMomentId, setDeletingMomentId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const deletingMomentIdRef = useRef<string | null>(null)
  const reducedMotionRef = useRef(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    bubblePlacementsRef.current = bubblePlacements
  }, [bubblePlacements])

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
      clearHoldTimer()
      if (pickedBubbleRef.current) {
        pickedBubbleRef.current.element.dataset.pickedUp = 'false'
        pickedBubbleRef.current = null
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
  }, [visibleSharedMomentIds])

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
    // Pointer, resize, and focus events can all fire in one frame. Coalescing
    // their DOM writes avoids layout thrashing on older phones.
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
    const clampedPan = calculateConstellationPan({
      origin: { x: 0, y: 0 },
      delta: panRef.current,
      field: { width, height },
      world: { width: worldWidth, height: worldHeight },
    })
    if (
      clampedPan.x !== panRef.current.x ||
      clampedPan.y !== panRef.current.y
    ) {
      panRef.current = clampedPan
      panStartRef.current = { ...clampedPan }
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
    const movingBubble = pickedBubbleRef.current !== null
    field.dataset.panning =
      pointer.pressed && draggedRef.current && !movingBubble ? 'true' : 'false'
    field.dataset.movingBubble = movingBubble ? 'true' : 'false'
    field.dataset.spaceMoved =
      pan.x !== initialPanRef.current.x || pan.y !== initialPanRef.current.y
        ? 'true'
        : 'false'

    // Motion and center-depth are composed here, rather than through React
    // state, because this path runs for every pointer frame.
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
        bubble.style.setProperty(
          '--bubble-remove-radius',
          `${(Math.max(bubble.offsetWidth, bubble.offsetHeight) * displayedScale * motion.scale) / 2}px`,
        )
        bubble.style.setProperty('--bubble-remove-shift-x', `${motion.x}px`)
        bubble.style.setProperty('--bubble-remove-shift-y', `${motion.y}px`)
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

  function clearHoldTimer() {
    if (holdTimerRef.current === null) return
    window.clearTimeout(holdTimerRef.current)
    holdTimerRef.current = null
  }

  function beginBubblePickup(
    bubble: HTMLElement,
    memoryId: string,
    ownedMomentId?: string,
  ) {
    clearHoldTimer()
    const label = bubble.dataset.memoryLabel || 'Memory'
    const startPosition = {
      top: bubble.offsetTop,
      left: bubble.offsetLeft,
    }
    // Store positions in world coordinates. The viewport may pan while a
    // bubble is held, but its saved placement must remain device-independent.
    pickedBubbleRef.current = {
      element: bubble,
      id: memoryId,
      label,
      startClient: { ...latestPointerClientRef.current },
      startPosition,
      currentPosition: startPosition,
    }
    bubble.dataset.pickedUp = 'true'
    longPressActivatedRef.current = true
    draggedRef.current = false
    setPickedUpMemoryId(memoryId)
    setMoveStatus(`${label} picked up. Keep holding and drag to move it.`)
    if (ownedMomentId && onDelete360) {
      setDeleteError('')
      setDeletionModeMomentId(ownedMomentId)
    }
    if (typeof navigator.vibrate === 'function') navigator.vibrate(12)
    scheduleRender()
  }

  function finishBubblePickup() {
    const picked = pickedBubbleRef.current
    if (!picked) return false

    const world = spaceRef.current
    if (world && world.clientWidth > 0 && world.clientHeight > 0) {
      const placement = normalizeBubblePosition(picked.currentPosition, {
        width: world.clientWidth,
        height: world.clientHeight,
      })
      const nextPlacements: BubblePlacementMap = {
        ...bubblePlacementsRef.current,
        [picked.id]: placement,
      }
      bubblePlacementsRef.current = nextPlacements
      setBubblePlacements(nextPlacements)
      saveBubblePlacements(nextPlacements)
    }

    picked.element.dataset.pickedUp = 'false'
    pickedBubbleRef.current = null
    setPickedUpMemoryId(null)
    setMoveStatus(`${picked.label} moved.`)
    scheduleRender()
    return true
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return
    if (activePointerRef.current !== null) return

    activePointerRef.current = event.pointerId
    dragStartRef.current = { x: event.clientX, y: event.clientY }
    latestPointerClientRef.current = { x: event.clientX, y: event.clientY }
    panStartRef.current = { ...panRef.current }
    draggedRef.current = false
    longPressActivatedRef.current = false

    const eventTarget = event.target as HTMLElement
    const targetBubble = eventTarget.closest<HTMLElement>(
      '.memory-bubble[data-memory-id]',
    )
    const targetMemoryId = targetBubble?.dataset.memoryId
    const ownedSharedBubble = eventTarget.closest<HTMLElement>(
      '.memory-bubble--shared[data-owned-by-current-user="true"]',
    )
    const ownedMomentId = ownedSharedBubble?.dataset.sharedMomentId
    if (
      deletionModeMomentId &&
      ownedMomentId !== deletionModeMomentId
    ) {
      setDeletionModeMomentId(null)
    }
    clearHoldTimer()
    // The second press in deletion mode picks up immediately. Otherwise a hold
    // distinguishes moving a bubble from opening it or panning empty space.
    if (targetBubble && targetMemoryId && !deletingMomentId) {
      if (ownedMomentId && deletionModeMomentId === ownedMomentId) {
        beginBubblePickup(targetBubble, targetMemoryId, ownedMomentId)
      } else {
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null
          beginBubblePickup(targetBubble, targetMemoryId, ownedMomentId)
        }, OWNED_MOMENT_HOLD_DELAY_MS)
      }
    }
    const captureTarget =
      eventTarget.closest<HTMLElement>(
        '.memory-bubble__surface, .memory-bubble',
      ) ?? fieldRef.current
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
      latestPointerClientRef.current = { x: event.clientX, y: event.clientY }
      const picked = pickedBubbleRef.current
      if (picked) {
        const field = fieldRef.current
        const space = spaceRef.current
        if (!field || !space) return
        const rect = field.getBoundingClientRect()
        const scaleX = rect.width > 0 ? field.clientWidth / rect.width : 1
        const scaleY = rect.height > 0 ? field.clientHeight / rect.height : 1
        const delta = {
          x: (event.clientX - picked.startClient.x) * scaleX,
          y: (event.clientY - picked.startClient.y) * scaleY,
        }
        const nextPosition = constrainBubblePosition({
          requested: {
            top: picked.startPosition.top + delta.y,
            left: picked.startPosition.left + delta.x,
          },
          bubble: {
            width: picked.element.offsetWidth,
            height: picked.element.offsetHeight,
          },
          world: { width: space.clientWidth, height: space.clientHeight },
        })
        picked.currentPosition = nextPosition
        picked.element.style.setProperty('--bubble-top', `${nextPosition.top}px`)
        picked.element.style.setProperty('--bubble-left', `${nextPosition.left}px`)
        if (Math.hypot(delta.x, delta.y) > 1) draggedRef.current = true
        hasExploredRef.current = true
        scheduleBubbleMotion(event, true)
        event.preventDefault()
        return
      }

      const delta = {
        x: event.clientX - dragStartRef.current.x,
        y: event.clientY - dragStartRef.current.y,
      }
      const travel = Math.hypot(delta.x, delta.y)
      const dragDistance =
        holdTimerRef.current === null
          ? CONSTELLATION_DRAG_DISTANCE_PX
          : OWNED_MOMENT_HOLD_CANCEL_DISTANCE_PX
      if (travel > dragDistance) {
        clearHoldTimer()
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
    clearHoldTimer()
    const droppedBubble = finishBubblePickup()
    if (draggedRef.current || longPressActivatedRef.current || droppedBubble) {
      armPointerClickSuppression()
    }
    longPressActivatedRef.current = false
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
    clearHoldTimer()
    const droppedBubble = finishBubblePickup()
    if (draggedRef.current || longPressActivatedRef.current || droppedBubble) {
      armPointerClickSuppression()
    }
    longPressActivatedRef.current = false
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
    // Mobile browsers synthesize a click after pointerup. Without this short
    // guard, dropping a bubble would also navigate into that memory.
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
      if (suppressResetTimerRef.current !== null) {
        window.clearTimeout(suppressResetTimerRef.current)
        suppressResetTimerRef.current = null
      }
      return
    }
    if (deletionModeMomentId === moment.id) {
      return
    }
    navigate(`/memory/shared-${moment.id}`, {
      state: { sourceMemoryId: `shared-${moment.id}` },
      viewTransition: true,
    })
  }

  function requestRemoveSharedMoment(moment: PanoramaMoment) {
    if (
      moment.ownedByCurrentUser !== true ||
      !onDelete360 ||
      deletingMomentIdRef.current
    ) {
      return
    }
    const confirmed = window.confirm(
      `Remove “${moment.label}” from your phone and your family’s phones?`,
    )
    if (!confirmed) return

    // React cannot disable the remove control until the next render. The ref
    // closes that gap so a rapid double tap cannot submit two family deletes.
    deletingMomentIdRef.current = moment.id
    setDeletingMomentId(moment.id)
    setDeleteError('')
    void onDelete360(moment.id)
      .then(() => setDeletionModeMomentId(null))
      .catch((reason) => {
        setDeleteError(
          reason instanceof Error
            ? reason.message
            : 'This moment could not be removed. Try again.',
        )
      })
      .finally(() => {
        deletingMomentIdRef.current = null
        setDeletingMomentId(null)
      })
  }

  return (
    <section className="memories-screen" aria-labelledby="moments-title">
      <AppWhimsy page="moments" />
      <header className="top-bar app-page-header moments-header">
        <div className="moments-header__copy">
          <p className="eyebrow app-page-header__eyebrow">Our family</p>
          <h1 id="moments-title" className="moments-title">
            Moments
            <span className="moments-title__heart" aria-hidden="true">♥</span>
          </h1>
          <time className="moments-date app-page-header__subtitle" dateTime={toLocalIsoDate(now)}>
            {formatLocalDay(now)}
          </time>
        </div>
      </header>

      <div
        ref={fieldRef}
        className="memory-constellation"
        aria-label="Family memory constellation"
        aria-describedby="memory-explore-instructions"
        data-interacting="false"
        data-pointer-visible="false"
        data-panning="false"
        data-moving-bubble="false"
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
          style={constellationSpaceStyle}
        >
          <svg
            className="memory-constellation__story-thread"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            focusable="false"
            aria-hidden="true"
          >
            <path d="M 7 8 C 22 4, 22 24, 39 19 S 64 8, 73 24 S 95 34, 84 47 S 52 50, 61 66 S 88 76, 73 89 S 38 82, 27 96" />
            <path d="M 2 63 C 14 53, 26 57, 31 71" />
          </svg>
          <svg
            className="memory-constellation__doodle memory-constellation__doodle--sun"
            viewBox="0 0 48 48"
            focusable="false"
            aria-hidden="true"
          >
            <circle cx="24" cy="24" r="7" />
            <path d="M24 4v7M24 37v7M4 24h7M37 24h7M9.8 9.8l5 5M33.2 33.2l5 5M38.2 9.8l-5 5M14.8 33.2l-5 5" />
          </svg>
          <svg
            className="memory-constellation__doodle memory-constellation__doodle--leaf"
            viewBox="0 0 48 48"
            focusable="false"
            aria-hidden="true"
          >
            <path d="M10 42c8-14 17-24 29-33M17 33c-6 0-9-3-10-8 6-1 10 1 12 5M25 25c-1-7 2-11 8-13 2 6 0 11-5 15M32 17c5-1 9 1 11 5-4 4-9 4-13 1" />
          </svg>
          <svg
            className="memory-constellation__doodle memory-constellation__doodle--spark"
            viewBox="0 0 40 40"
            focusable="false"
            aria-hidden="true"
          >
            <path d="M20 4c1 9 5 14 13 16-8 2-12 7-13 16-1-9-5-14-13-16 8-2 12-7 13-16Z" />
          </svg>
          {constellationMemories.map((memory, order) => (
            <MemoryBubble
              key={memory.id}
              memory={memory}
              order={order}
              entryFocused={entryMemoryIdRef.current === memory.id}
              placement={bubblePlacements[memory.id]}
              pickedUp={pickedUpMemoryId === memory.id}
              onOpen={openMemory}
            />
          ))}
          {visibleSharedMoments.map((sharedMoment, sharedIndex) => (
            <SharedMomentBubble
              key={sharedMoment.id}
              moment={sharedMoment}
              order={constellationMemories.length + sharedIndex}
              sharedIndex={sharedIndex}
              sharedCount={visibleSharedMoments.length}
              position={sharedMomentPositions[sharedIndex]}
              placement={bubblePlacements[`shared-${sharedMoment.id}`]}
              pickedUp={pickedUpMemoryId === `shared-${sharedMoment.id}`}
              entryFocused={
                entryMemoryIdRef.current === `shared-${sharedMoment.id}`
              }
              deletionMode={deletionModeMomentId === sharedMoment.id}
              deleting={deletingMomentId === sharedMoment.id}
              onEnterDeletionMode={(momentId) => {
                setDeleteError('')
                setDeletionModeMomentId(momentId)
              }}
              onRequestRemove={requestRemoveSharedMoment}
              onOpen={openSharedMoment}
            />
          ))}
        </div>
      </div>

      {onUpload360 ? (
        <Capture360Shortcut onClick={onUpload360} />
      ) : null}

      {deleteError ? (
        <p className="memory-delete-status" role="alert">
          {deleteError}
        </p>
      ) : null}

      <p className="screen-reader-only" role="status" aria-live="polite">
        {moveStatus}
      </p>

      <p id="memory-explore-instructions" className="screen-reader-only">
        One memory is brought forward when Moments opens. Drag or swipe empty space to explore the memory space. The memory nearest the center grows larger. Touch and hold any bubble, then keep holding and drag to move that bubble. Use Tab to center each memory, then select one to open its panoramic view. Touch and hold a 360 moment you shared to also reveal its remove control.
      </p>
    </section>
  )
}
