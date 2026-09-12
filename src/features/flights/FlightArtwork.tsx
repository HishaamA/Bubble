/** Renders decorative travel artwork outside the accessibility tree. */
export function FlightDoodleHeader() {
  return (
    <div className="flight-doodle-header" aria-hidden="true">
      <svg className="flight-doodle-header__cloud flight-doodle-header__cloud--large" viewBox="0 0 72 30" aria-hidden="true">
        <path d="M6 23c-4-1-4-8 1-10 2-1 4 0 5 1 1-6 6-9 11-7 2-6 10-8 14-3 3-2 8-1 10 3 6-1 11 3 11 8 8-1 11 9 4 12H6Z" />
      </svg>
      <svg className="flight-doodle-header__journey" viewBox="0 0 208 58" aria-hidden="true">
        <path className="flight-doodle-header__route" d="M2 42c14-11 29-9 36 2 5 8-6 13-12 6-9-11 4-31 23-26 22 7 28 19 51 19C123 43 139 41 160 38" />
        <circle className="flight-doodle-header__route-join" cx="160" cy="38" r="1.4" />
        <path className="flight-doodle-header__plane" d="M160 38 154 23 202 5l-28 47-6-20-8 6Zm8-6 34-27m-28 47-6-20" />
      </svg>
      <svg className="flight-doodle-header__cloud flight-doodle-header__cloud--small" viewBox="0 0 72 30" aria-hidden="true">
        <path d="M6 23c-4-1-4-8 1-10 2-1 4 0 5 1 1-6 6-9 11-7 2-6 10-8 14-3 3-2 8-1 10 3 6-1 11 3 11 8 8-1 11 9 4 12H6Z" />
      </svg>
    </div>
  )
}

/** Renders the shared plane glyph with optional accessible naming. */
export function PlaneIcon({ title }: { title?: string }) {
  return (
    <svg
      className="flight-plane-icon"
      viewBox="0 0 24 24"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d="M21.4 13.2 14 10.4V4.7c0-1.1-.9-2.7-2-2.7s-2 1.6-2 2.7v5.7l-7.4 2.8c-.4.2-.7.6-.6 1.1l.2 1.1c.1.4.5.7.9.6l6.9-1.1v4l-2.1 1.5c-.3.2-.4.5-.3.8l.2.7c.1.3.4.5.8.4l3.4-.8 3.4.8c.4.1.7-.1.8-.4l.2-.7c.1-.3 0-.6-.3-.8L14 18.9v-4l6.9 1.1c.4.1.8-.2.9-.6l.2-1.1c.1-.5-.2-.9-.6-1.1Z" />
    </svg>
  )
}

/** Renders the alert-control glyph. */
export function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" />
    </svg>
  )
}

/** Renders the provider-refresh glyph. */
export function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 7v5h-5M4 17v-5h5M6.1 9A7 7 0 0 1 18 6l2 1M17.9 15A7 7 0 0 1 6 18l-2-1" />
    </svg>
  )
}

/** Renders the stop-tracking glyph. */
export function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  )
}

/** Renders the ticket-style route separator at regular or compact scale. */
export function FlightRouteMark({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      className={compact ? 'flight-route-mark flight-route-mark--compact' : 'flight-route-mark'}
      viewBox="0 0 100 24"
      aria-hidden="true"
    >
      <line className="flight-route-mark__dots" x1="2" y1="12" x2="98" y2="12" />
      <circle className="flight-route-mark__mask" cx="50" cy="12" r={compact ? 7.5 : 9} />
      <g className="flight-route-mark__plane" transform="translate(50 12) rotate(90) scale(.62) translate(-12 -12)">
        <path d="M21.4 13.2 14 10.4V4.7c0-1.1-.9-2.7-2-2.7s-2 1.6-2 2.7v5.7l-7.4 2.8c-.4.2-.7.6-.6 1.1l.2 1.1c.1.4.5.7.9.6l6.9-1.1v4l-2.1 1.5c-.3.2-.4.5-.3.8l.2.7c.1.3.4.5.8.4l3.4-.8 3.4.8c.4.1.7-.1.8-.4l.2-.7c.1-.3 0-.6-.3-.8L14 18.9v-4l6.9 1.1c.4.1.8-.2.9-.6l.2-1.1c.1-.5-.2-.9-.6-1.1Z" />
      </g>
    </svg>
  )
}
