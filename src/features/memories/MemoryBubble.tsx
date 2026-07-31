import type { CSSProperties, MouseEvent } from 'react'
import { createBubbleDrift } from './bubbleDrift'
import type { Memory } from './memories'

const SPRITE_WIDTH = 1536

type MemoryBubbleProps = {
  memory: Memory
  order: number
  onOpen: (memory: Memory, event: MouseEvent<HTMLButtonElement>) => void
}

export function MemoryBubble({ memory, order, onOpen }: MemoryBubbleProps) {
  const spriteScale = SPRITE_WIDTH / memory.crop.diameter
  const spriteStyle: CSSProperties = {
    width: `${spriteScale * 100}%`,
    left: `${(-memory.crop.left / memory.crop.diameter) * 100}%`,
    top: `${(-memory.crop.top / memory.crop.diameter) * 100}%`,
  }
  const bubbleStyle = {
    '--bubble-top': memory.position.top,
    '--bubble-left': memory.position.left,
    '--bubble-size': memory.position.size,
    '--bubble-order': order,
  } as CSSProperties
  const motionStyle = {
    viewTransitionName: `memory-${memory.id}`,
  } as CSSProperties
  const drift = createBubbleDrift(order, memory.featured)
  const driftStyle = {
    '--bubble-drift-x': drift.x,
    '--bubble-drift-y': drift.y,
    '--bubble-drift-reverse-x': drift.reverseX,
    '--bubble-drift-reverse-y': drift.reverseY,
    '--bubble-drift-duration': drift.duration,
    '--bubble-drift-delay': drift.delay,
  } as CSSProperties

  return (
    <button
      type="button"
      id={`memory-${memory.id}`}
      data-memory-id={memory.id}
      className={`memory-bubble${memory.featured ? ' memory-bubble--featured' : ''}`}
      style={bubbleStyle}
      aria-label={`Open ${memory.label} memory from ${memory.date}`}
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
          {memory.featured ? <span className="memory-bubble__hint">Open memory</span> : null}
        </span>
      </span>
    </button>
  )
}
