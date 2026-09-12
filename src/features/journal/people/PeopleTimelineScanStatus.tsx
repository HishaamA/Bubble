type PeopleTimelineScanStatusProps = {
  progress: { completed: number; total: number } | null
  hasPendingPhotos: boolean
  scanDisabled: boolean
  clearDisabled: boolean
  clearing: boolean
  confirmingClear: boolean
  message: string
  error: boolean
  onScan: () => void
  onCancelScan: () => void
  onToggleClear: () => void
  onClear: () => void
  onKeep: () => void
}

/** Privacy controls reflect the scan owner's state; they never start background work themselves. */
export function PeopleTimelineScanStatus({
  progress,
  hasPendingPhotos,
  scanDisabled,
  clearDisabled,
  clearing,
  confirmingClear,
  message,
  error,
  onScan,
  onCancelScan,
  onToggleClear,
  onClear,
  onKeep,
}: PeopleTimelineScanStatusProps) {
  return (
    <>
      <aside className="people-timeline__privacy" aria-label="Face matching privacy">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7.5 10V7.7a4.5 4.5 0 0 1 9 0V10M5.5 10h13v10h-13zM12 14v2.5" />
        </svg>
        <div>
          <p>Face matching stays on this device</p>
          <span>Reference photos are scanned once and never stored. Your private face profiles never leave this phone.</span>
        </div>
        <div className="people-timeline__privacy-actions">
          <button type="button" disabled={scanDisabled} onClick={onScan}>
            {progress
              ? `${progress.completed}/${progress.total}`
              : hasPendingPhotos ? 'Check new photos' : 'Up to date'}
          </button>
          {progress ? <button type="button" onClick={onCancelScan}>Cancel</button> : null}
          <button
            type="button"
            className="people-timeline__clear-face-button"
            disabled={clearDisabled}
            aria-expanded={confirmingClear}
            onClick={onToggleClear}
          >
            {clearing ? 'Clearing…' : 'Clear face data'}
          </button>
        </div>
      </aside>
      {confirmingClear ? (
        <div className="people-timeline__clear-confirm" role="group" aria-label="Confirm clear face data">
          <p>Clear face references and detections? Names and manual photo tags will stay.</p>
          <button type="button" onClick={onClear}>Clear</button>
          <button type="button" onClick={onKeep}>Keep</button>
        </div>
      ) : null}
      {message ? (
        <p className="people-timeline__scan-status" role="status" data-error={error ? 'true' : 'false'}>
          {message}
        </p>
      ) : null}
    </>
  )
}
