export type BubbleDrift = {
  x: string
  y: string
  reverseX: string
  reverseY: string
  duration: string
  delay: string
}

/** Stable per-bubble drift keeps the constellation organic without jitter. */
export function createBubbleDrift(order: number, featured = false): BubbleDrift {
  const safeOrder = Math.max(0, Math.floor(order))
  const horizontalDirection = safeOrder % 2 === 0 ? 1 : -1
  const verticalDirection = Math.floor(safeOrder / 2) % 2 === 0 ? 1 : -1
  const horizontal = featured ? 4.5 : 6 + ((safeOrder * 7) % 6) * 1.1
  const vertical = featured ? 4 : 5.5 + ((safeOrder * 11) % 6)
  const duration = featured ? 26 : 19 + (safeOrder % 5) * 2.6
  const delay = -((safeOrder * 3.7) % duration)

  return {
    x: `${horizontal * horizontalDirection}px`,
    y: `${vertical * verticalDirection}px`,
    reverseX: `${horizontal * horizontalDirection * -1}px`,
    reverseY: `${vertical * verticalDirection * -1}px`,
    duration: `${duration}s`,
    delay: `${delay}s`,
  }
}
