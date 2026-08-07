export type BubbleDrift = {
  x: string
  y: string
  reverseX: string
  reverseY: string
  duration: string
  delay: string
  phoneX: string
  phoneY: string
  phoneReverseX: string
  phoneReverseY: string
  phoneDuration: string
}

/** Stable per-bubble drift keeps the constellation organic without jitter. */
export function createBubbleDrift(order: number): BubbleDrift {
  const safeOrder = Math.max(0, Math.floor(order))
  const horizontalDirection = safeOrder % 2 === 0 ? 1 : -1
  const verticalDirection = Math.floor(safeOrder / 2) % 2 === 0 ? 1 : -1
  const horizontal = 6 + ((safeOrder * 7) % 6) * 1.1
  const vertical = 5.5 + ((safeOrder * 11) % 6)
  const duration = 19 + (safeOrder % 5) * 2.6
  const delay = -((safeOrder * 3.7) % duration)
  const phoneHorizontal = Math.min(14, Math.round(horizontal * 13) / 10)
  const phoneVertical = Math.min(13, Math.round(vertical * 12.5) / 10)
  const phoneDuration = Math.max(17, Math.round(duration * 8.2) / 10)

  return {
    x: `${horizontal * horizontalDirection}px`,
    y: `${vertical * verticalDirection}px`,
    reverseX: `${horizontal * horizontalDirection * -1}px`,
    reverseY: `${vertical * verticalDirection * -1}px`,
    duration: `${duration}s`,
    delay: `${delay}s`,
    phoneX: `${phoneHorizontal * horizontalDirection}px`,
    phoneY: `${phoneVertical * verticalDirection}px`,
    phoneReverseX: `${phoneHorizontal * horizontalDirection * -1}px`,
    phoneReverseY: `${phoneVertical * verticalDirection * -1}px`,
    phoneDuration: `${phoneDuration}s`,
  }
}
