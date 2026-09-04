export type MotionPoint = {
  x: number
  y: number
}

export type MotionSize = {
  width: number
  height: number
}

export type BubbleGeometry = MotionPoint & {
  size: number
}

export type BubbleMotion = {
  x: number
  y: number
  scale: number
  proximity: number
}

type BubbleMotionInput = {
  pointer: MotionPoint
  field: MotionSize
  bubble: BubbleGeometry
  order: number
  pressed: boolean
}

/** Bounds motion values before they become CSS transforms. */
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value))

/** Stabilizes transform strings to avoid sub-pixel churn between frames. */
const round = (value: number) => Math.round(value * 100) / 100

/**
 * Resolves pointer repulsion, depth parallax, and press feedback for one bubble.
 * Returned offsets are clamped so the bubble remains inside its visible field.
 */
export function calculateBubbleMotion({
  pointer,
  field,
  bubble,
  order,
  pressed,
}: BubbleMotionInput): BubbleMotion {
  if (field.width <= 0 || field.height <= 0) {
    return { x: 0, y: 0, scale: 1, proximity: 0 }
  }

  const centerX = bubble.x + bubble.size / 2
  const centerY = bubble.y + bubble.size / 2
  const deltaX = centerX - pointer.x
  const deltaY = centerY - pointer.y
  const distance = Math.hypot(deltaX, deltaY)
  const interactionRadius = clamp(
    Math.min(field.width, field.height) * 0.36,
    108,
    190,
  )
  const rawProximity = clamp(1 - distance / interactionRadius, 0, 1)
  const proximity = rawProximity ** 2 * (3 - 2 * rawProximity)
  const fallbackAngle = (order * 137.5 * Math.PI) / 180
  const directionX = distance > 0.01 ? deltaX / distance : Math.cos(fallbackAngle)
  const directionY = distance > 0.01 ? deltaY / distance : Math.sin(fallbackAngle)
  const repulsion = proximity * (pressed ? 26 : 18)
  const depth = 0.45 + (order % 5) * 0.11
  const normalizedX = pointer.x / field.width - 0.5
  const normalizedY = pointer.y / field.height - 0.5
  const parallaxX = normalizedX * 11 * depth
  const parallaxY = normalizedY * 9 * depth

  const proposedX = directionX * repulsion + parallaxX
  const proposedY = directionY * repulsion + parallaxY
  const edgePadding = 2
  const minimumX = Math.min(0, -bubble.x + edgePadding)
  const maximumX = Math.max(
    0,
    field.width - bubble.x - bubble.size - edgePadding,
  )
  const minimumY = Math.min(0, -bubble.y + edgePadding)
  const maximumY = Math.max(
    0,
    field.height - bubble.y - bubble.size - edgePadding,
  )

  return {
    x: round(clamp(proposedX, minimumX, maximumX)),
    y: round(clamp(proposedY, minimumY, maximumY)),
    scale: round(1 + proximity * (pressed ? 0.08 : 0.055)),
    proximity: round(proximity),
  }
}
