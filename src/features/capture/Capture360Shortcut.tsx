import './Capture360Page.css'

type Capture360ShortcutProps = {
  onClick: () => void
  className?: string
}

/** Draws the compact camera mark used by the floating 360 entry point. */
function Camera360Icon() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 7.6h3l1.3-2h6.4l1.3 2h3A2.5 2.5 0 0 1 22 10.1v7.4a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5v-7.4a2.5 2.5 0 0 1 2.5-2.5Z" />
      <circle cx="12" cy="13.5" r="3.25" />
      <path d="M18.5 11.2h.01" />
    </svg>
  )
}

/** A right-edge entry point that can be mounted over the Memories screen. */
export function Capture360Shortcut({ onClick, className = '' }: Capture360ShortcutProps) {
  return (
    <button
      className={`capture-360-shortcut ${className}`.trim()}
      type="button"
      aria-label="Upload a 360 photo now"
      onClick={onClick}
    >
      <span className="capture-360-shortcut__icon"><Camera360Icon /></span>
      <span className="capture-360-shortcut__copy">
        <small>Upload</small>
        <strong>360 now</strong>
      </span>
    </button>
  )
}
