import { useId } from 'react'

type MemoryArcLabelsProps = {
  title: string
  sender: string
}

const MAX_TITLE_LENGTH = 24
const MAX_SENDER_LENGTH = 18

/** Truncates display copy on a word boundary while preserving the full title elsewhere. */
function compactLabel(value: string, maxLength: number) {
  const label = value.trim().replace(/\s+/g, ' ')
  if (label.length <= maxLength) return label

  return `${label.slice(0, maxLength - 1).trimEnd()}…`
}

/** Draws compact decorative labels around a memory bubble's circular edge. */
export function MemoryArcLabels({ title, sender }: MemoryArcLabelsProps) {
  const pathPrefix = `memory-arc-${useId().replace(/:/g, '')}`
  const titlePathId = `${pathPrefix}-title`
  const senderPathId = `${pathPrefix}-sender`

  return (
    <span className="memory-bubble__arc-labels" aria-hidden="true">
      <svg viewBox="0 0 100 100" focusable="false">
        <defs>
          <path
            id={titlePathId}
            className="memory-bubble__arc-path"
            d="M 10 50 A 40 40 0 0 1 90 50"
          />
          <path
            id={senderPathId}
            className="memory-bubble__arc-path"
            d="M 5 50 A 45 45 0 0 0 95 50"
          />
        </defs>
        <text className="memory-bubble__arc-text memory-bubble__arc-title">
          <textPath
            href={`#${titlePathId}`}
            startOffset="50%"
            textAnchor="middle"
          >
            {compactLabel(title, MAX_TITLE_LENGTH)}
          </textPath>
        </text>
        <text className="memory-bubble__arc-text memory-bubble__arc-sender">
          <textPath
            href={`#${senderPathId}`}
            startOffset="50%"
            textAnchor="middle"
          >
            {compactLabel(sender, MAX_SENDER_LENGTH)}
          </textPath>
        </text>
      </svg>
    </span>
  )
}
