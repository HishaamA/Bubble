import type { CSSProperties, MouseEvent } from 'react'
import { createBubbleDrift } from './bubbleDrift'
import { MemoryArcLabels } from './MemoryArcLabels'
import type { PanoramaMoment } from './shared'

type SharedMomentBubbleProps = {
  moment: PanoramaMoment
  order: number
  entryFocused?: boolean
  onOpen: (moment: PanoramaMoment, event: MouseEvent<HTMLButtonElement>) => void
}

export function SharedMomentBubble({
  moment,
  order,
  entryFocused = false,
  onOpen,
}: SharedMomentBubbleProps) {
  if (!moment.objectUrl) return null

  const bubbleStyle = {
    '--bubble-top': '32%',
    '--bubble-left': '83%',
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
    '--bubble-phone-drift-x': drift.phoneX,
    '--bubble-phone-drift-y': drift.phoneY,
    '--bubble-phone-drift-reverse-x': drift.phoneReverseX,
    '--bubble-phone-drift-reverse-y': drift.phoneReverseY,
    '--bubble-phone-drift-duration': drift.phoneDuration,
  } as CSSProperties
  const date = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(moment.createdAt))
  const annotationCount = moment.annotations?.length ?? 0

  return (
    <button
      type="button"
      id={`memory-shared-${moment.id}`}
      data-memory-id={`shared-${moment.id}`}
      data-entry-focus={entryFocused ? 'true' : 'false'}
      className="memory-bubble memory-bubble--shared"
      style={bubbleStyle}
      aria-label={`Open ${moment.label} shared by ${moment.uploaderDisplayName} on ${date}${annotationCount > 0 ? `, ${annotationCount} memory ${annotationCount === 1 ? 'point' : 'points'}` : ''}`}
      onClick={(event) => onOpen(moment, event)}
    >
      <span className="memory-bubble__drift" style={driftStyle}>
        <span className="memory-bubble__motion" style={motionStyle}>
          <span className="memory-bubble__image" aria-hidden="true">
            <img src={moment.objectUrl} alt="" draggable="false" />
          </span>
          <MemoryArcLabels
            title={moment.label}
            sender={moment.uploaderDisplayName}
          />
          {annotationCount > 0 ? (
            <span className="memory-bubble__point-count" aria-hidden="true">
              <span>+</span>
              {annotationCount}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  )
}
