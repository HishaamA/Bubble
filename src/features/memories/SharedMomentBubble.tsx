import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react'
import { createBubbleDrift } from './bubbleDrift'
import type { BubblePlacement } from './bubblePlacement'
import { MemoryArcLabels } from './MemoryArcLabels'
import type { PanoramaMoment } from './shared'
import { getSharedMomentPosition } from './sharedMomentLayout'

type SharedMomentBubbleProps = {
  moment: PanoramaMoment
  order: number
  entryFocused?: boolean
  deletionMode?: boolean
  deleting?: boolean
  sharedIndex?: number
  sharedCount?: number
  position?: readonly [string, string]
  placement?: BubblePlacement
  pickedUp?: boolean
  onEnterDeletionMode?: (momentId: string) => void
  onRequestRemove?: (moment: PanoramaMoment) => void
  onOpen: (moment: PanoramaMoment, event: MouseEvent<HTMLButtonElement>) => void
}

const BUBBLE_ACCENTS = ['coral', 'sage', 'sky', 'sun', 'lavender'] as const

/**
 * Renders an uploaded panorama with ownership-aware removal controls.
 * Moments without a usable object URL stay out of the interactive layout.
 */
export function SharedMomentBubble({
  moment,
  order,
  entryFocused = false,
  deletionMode = false,
  deleting = false,
  sharedIndex = 0,
  sharedCount = 1,
  position,
  placement,
  pickedUp = false,
  onEnterDeletionMode,
  onRequestRemove,
  onOpen,
}: SharedMomentBubbleProps) {
  if (!moment.objectUrl) return null

  const resolvedPosition =
    position ?? getSharedMomentPosition(sharedIndex, sharedCount)
  const bubbleStyle = {
    '--bubble-top': placement ? `${placement.top}%` : resolvedPosition[0],
    '--bubble-left': placement ? `${placement.left}%` : resolvedPosition[1],
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

  const canRemove = moment.ownedByCurrentUser === true && Boolean(onRequestRemove)

  return (
    <div
      data-memory-id={`shared-${moment.id}`}
      data-memory-label={moment.label}
      data-bubble-accent={BUBBLE_ACCENTS[order % BUBBLE_ACCENTS.length]}
      data-shared-moment-id={moment.id}
      data-picked-up={pickedUp ? 'true' : 'false'}
      data-owned-by-current-user={
        moment.ownedByCurrentUser === true ? 'true' : 'false'
      }
      data-delete-mode={deletionMode ? 'true' : 'false'}
      data-entry-focus={entryFocused ? 'true' : 'false'}
      className="memory-bubble memory-bubble--shared"
      style={bubbleStyle}
    >
      <span className="memory-bubble__drift" style={driftStyle}>
        <span className="memory-bubble__motion" style={motionStyle}>
          <button
            type="button"
            id={`memory-shared-${moment.id}`}
            className="memory-bubble__surface"
            aria-label={
              deletionMode
                ? `${moment.label} selected for removal`
                : `Open ${moment.label} shared by ${moment.uploaderDisplayName} on ${date}${annotationCount > 0 ? `, ${annotationCount} memory ${annotationCount === 1 ? 'point' : 'points'}` : ''}`
            }
            disabled={deleting}
            onClick={(event) => onOpen(moment, event)}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              if (
                moment.ownedByCurrentUser === true &&
                (event.key === 'Delete' || event.key === 'Backspace')
              ) {
                event.preventDefault()
                onEnterDeletionMode?.(moment.id)
              }
            }}
          >
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
          </button>
        </span>
        {canRemove ? (
          <button
            type="button"
            className="memory-bubble__remove"
            data-visible={deletionMode ? 'true' : 'false'}
            aria-label={`Remove ${moment.label} from your family`}
            disabled={deleting}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onRequestRemove?.(moment)
            }}
          >
            <span aria-hidden="true">{deleting ? '…' : '×'}</span>
          </button>
        ) : null}
      </span>
    </div>
  )
}
