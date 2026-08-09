import type { CSSProperties, MouseEvent } from 'react'
import { createBubbleDrift } from './bubbleDrift'
import type { BubblePlacement } from './bubblePlacement'
import { MemoryArcLabels } from './MemoryArcLabels'
import type { Memory } from './memories'

const SPRITE_WIDTH = 1536

type MemoryBubbleProps = {
  memory: Memory
  order: number
  entryFocused?: boolean
  placement?: BubblePlacement
  pickedUp?: boolean
  onOpen: (memory: Memory, event: MouseEvent<HTMLButtonElement>) => void
}

export function MemoryBubble({
  memory,
  order,
  entryFocused = false,
  placement,
  pickedUp = false,
  onOpen,
}: MemoryBubbleProps) {
  const spriteScale = SPRITE_WIDTH / memory.crop.diameter
  const spriteStyle: CSSProperties = {
    width: `${spriteScale * 100}%`,
    left: `${(-memory.crop.left / memory.crop.diameter) * 100}%`,
    top: `${(-memory.crop.top / memory.crop.diameter) * 100}%`,
  }
  const bubbleStyle = {
    '--bubble-top': placement ? `${placement.top}%` : memory.position.top,
    '--bubble-left': placement ? `${placement.left}%` : memory.position.left,
    '--bubble-order': order,
  } as CSSProperties
  const motionStyle = {
    viewTransitionName: `memory-${memory.id}`,
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

  return (
    <button
      type="button"
      id={`memory-${memory.id}`}
      data-memory-id={memory.id}
      data-memory-label={memory.label}
      data-picked-up={pickedUp ? 'true' : 'false'}
      data-entry-focus={entryFocused ? 'true' : 'false'}
      className="memory-bubble"
      style={bubbleStyle}
      aria-label={`Open ${memory.label} memory from ${memory.sender}, ${memory.date}`}
      onClick={(event) => onOpen(memory, event)}
    >
      <span className="memory-bubble__drift" style={driftStyle}>
        <span className="memory-bubble__motion" style={motionStyle}>
          <span className="memory-bubble__image" aria-hidden="true">
            <img
              src="/assets/design/kinsphere-ui-reference.png"
              alt=""
              draggable="false"
              style={spriteStyle}
            />
          </span>
          <MemoryArcLabels title={memory.label} sender={memory.sender} />
        </span>
      </span>
    </button>
  )
}
