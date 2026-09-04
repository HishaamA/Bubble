import type { BubbleGeometry, MotionPoint, MotionSize } from './bubbleMotion'

export type ConstellationPanInput = {
  origin: MotionPoint
  delta: MotionPoint
  field: MotionSize
  world: MotionSize
}

export type InitialConstellationPanInput = {
  field: MotionSize
  world: MotionSize
}

export type CenterDepthInput = {
  field: MotionSize
  bubble: BubbleGeometry
  pan: MotionPoint
}

export type BubbleCenterDepth = {
  scale: number
  proximity: number
  distance: number
}

/** Keeps pan and depth calculations inside their physical limits. */
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value))

/** Produces stable transform values without visible precision loss. */
const round = (value: number) => Math.round(value * 100) / 100

/**
 * Lets any point in the oversized world travel through the viewport center.
 * This makes every equally-sized memory eligible to become the focused bubble.
 */
export function calculateConstellationPan({
  origin,
  delta,
  field,
  world,
}: ConstellationPanInput): MotionPoint {
  if (
    field.width <= 0 ||
    field.height <= 0 ||
    world.width <= 0 ||
    world.height <= 0
  ) {
    return { x: 0, y: 0 }
  }

  const minimumX = Math.min(0, field.width / 2 - world.width)
  const maximumX = Math.max(0, field.width / 2)
  const minimumY = Math.min(0, field.height / 2 - world.height)
  const maximumY = Math.max(0, field.height / 2)

  return {
    x: round(clamp(origin.x + delta.x, minimumX, maximumX)),
    y: round(clamp(origin.y + delta.y, minimumY, maximumY)),
  }
}

/** Centers an oversized constellation before a specific bubble is selected. */
export function calculateInitialConstellationPan({
  field,
  world,
}: InitialConstellationPanInput): MotionPoint {
  if (
    field.width <= 0 ||
    field.height <= 0 ||
    world.width <= 0 ||
    world.height <= 0
  ) {
    return { x: 0, y: 0 }
  }

  return {
    x: round((field.width - world.width) / 2),
    y: round((field.height - world.height) / 2),
  }
}

/**
 * Apple Watch-style depth: items crossing the visual center come forward,
 * while peripheral items become smaller without disappearing.
 */
export function calculateCenterDepth({
  field,
  bubble,
  pan,
}: CenterDepthInput): BubbleCenterDepth {
  if (field.width <= 0 || field.height <= 0 || bubble.size <= 0) {
    return { scale: 1, proximity: 0, distance: Number.POSITIVE_INFINITY }
  }

  const bubbleCenterX = bubble.x + bubble.size / 2 + pan.x
  const bubbleCenterY = bubble.y + bubble.size / 2 + pan.y
  const horizontalRadius = Math.max(field.width * 0.68, 1)
  const verticalRadius = Math.max(field.height * 0.52, 1)
  const normalizedDistance = Math.hypot(
    (bubbleCenterX - field.width / 2) / horizontalRadius,
    (bubbleCenterY - field.height / 2) / verticalRadius,
  )
  const rawProximity = clamp(1 - normalizedDistance, 0, 1)
  const proximity = rawProximity ** 2 * (3 - 2 * rawProximity)

  return {
    // A deliberately dramatic Watch-style lens: memories at the edge recede,
    // while the one crossing the screen's optical center comes right forward.
    // Entry focus is chosen randomly, so the dramatic depth never hard-codes
    // one family moment as permanently more important than the others.
    scale: round(0.52 + proximity * 2.08),
    proximity: round(proximity),
    distance: round(normalizedDistance),
  }
}
