import type { CSSProperties, MouseEvent } from 'react'
import { createBubbleDrift } from './bubbleDrift'
import type { PanoramaMoment } from './shared'

type SharedMomentBubbleProps = {
  moment: PanoramaMoment
  order: number
  onOpen: (moment: PanoramaMoment, event: MouseEvent<HTMLButtonElement>) => void
}

export function SharedMomentBubble({
  moment,
  order,
  onOpen,
}: SharedMomentBubbleProps) {
  if (!moment.objectUrl) return null

  const bubbleStyle = {
    '--bubble-top': '42%',
    '--bubble-left': '80%',
    '--bubble-size': 'clamp(5.1rem, 19vw, 6.5rem)',
    '--bubble-order': order,
  } as CSSProperties
  const motionStyle = {
    viewTransitionName: `memory-shared-${moment.id}`,
  } as CSSProperties
  const drift = createBubbleDrift(order)
  const driftStyle = {
    '--bubble-drift-x': drift.x,
    '--bubble-drift-y': drift.y,
    '--bubble-drift-reverse-x': drift.reverseX,
    '--bubble-drift-reverse-y': drift.reverseY,
    '--bubble-drift-duration': drift.duration,
    '--bubble-drift-delay': drift.delay,
  } as CSSProperties
  const date = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(moment.createdAt))

  return (
    <button
      type="button"
      id={`memory-shared-${moment.id}`}
      data-memory-id={`shared-${moment.id}`}
      className="memory-bubble memory-bubble--shared"
      style={bubbleStyle}
      aria-label={`Open ${moment.label} shared by ${moment.uploaderDisplayName} on ${date}`}
      onClick={(event) => onOpen(moment, event)}
    >
      <span className="memory-bubble__drift" style={driftStyle}>
        <span className="memory-bubble__motion" style={motionStyle}>
          <span className="memory-bubble__image" aria-hidden="true">
            <img src={moment.objectUrl} alt="" draggable="false" />
          </span>
          <span className="memory-bubble__new-badge" aria-hidden="true">
            New
          </span>
        </span>
      </span>
    </button>
  )
}
