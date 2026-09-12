import type { Ref } from 'react'
import type { DailyCapturePhase, DailyCaptureWindow } from './captureWindow'
import type { CaptureSource } from './captureTypes'
import { CaptureIcon } from './CaptureIcon'

type CaptureStartPanelProps = {
  source: CaptureSource
  phase: DailyCapturePhase
  captureWindow: DailyCaptureWindow
  interactionBusy: boolean
  guidedCaptureAvailable: boolean
  guidedCaptureRunning: boolean
  checking: boolean
  guidedCaptureStatus: string
  error: string
  connectedFamilySync: boolean
  guidedCaptureButtonRef: Ref<HTMLButtonElement>
  onGuidedCapture: (source: CaptureSource) => void
  onOpenPicker: (source: CaptureSource, picker: 'camera' | 'library') => void
  onDailyMode: () => void
}

const timeFormatter = new Intl.DateTimeFormat('en', {
  hour: 'numeric',
  minute: '2-digit',
})

/** Maps the daily-window state to stable, non-interactive explanatory copy. */
function getPhaseCopy(phase: DailyCapturePhase) {
  if (phase === 'open') {
    return {
      title: 'The family window is open',
      body: 'Share one 360 photo with everyone before it closes.',
    }
  }

  if (phase === 'closed') {
    return {
      title: 'That’s today’s moment',
      body: 'Tomorrow brings another little window for the family.',
    }
  }

  if (phase === 'complete') {
    return {
      title: 'Shared for today',
      body: 'Your family’s next moment arrives tomorrow.',
    }
  }

  return {
    title: 'A little moment, sometime today',
    body: 'Everyone gets the same 15-minute window to share one 360 photo.',
  }
}

/** Controlled entry screens; camera ownership and mode changes stay in the controller. */
export function CaptureStartPanel({
  source, phase, captureWindow, interactionBusy, guidedCaptureAvailable,
  guidedCaptureRunning, checking, guidedCaptureStatus, error, connectedFamilySync,
  guidedCaptureButtonRef, onGuidedCapture, onOpenPicker, onDailyMode,
}: CaptureStartPanelProps) {
  const canUseDailyWindow = phase === 'open'
  const phaseCopy = getPhaseCopy(phase)
  return (
    <>
      {source === 'manual' ? (
        <section className="ks-card capture-manual-panel" aria-labelledby="manual-upload-title">
          <h2 id="manual-upload-title">Capture every direction</h2>
          <p>Bubble places a quiet field of dots around you and takes each view automatically when your phone is lined up and still.</p>
          <ol className="capture-panorama-steps" aria-label="How guided 360 capture works">
            <li><span>1</span><p><strong>Stand in one place</strong>Keep the phone close to where your head will be in VR.</p></li>
            <li><span>2</span><p><strong>Follow the dots</strong>Turn slowly through the middle, ceiling, and floor.</p></li>
            <li><span>3</span><p><strong>Hold for a moment</strong>Each aligned view captures itself. No shutter tapping.</p></li>
          </ol>
          <button
            ref={guidedCaptureButtonRef}
            className="ks-primary-button"
            type="button"
            disabled={interactionBusy}
            onClick={() => void onGuidedCapture('manual')}
          >
            <CaptureIcon name="camera" />
            {guidedCaptureRunning
              ? 'Preparing capture…'
              : guidedCaptureAvailable
                ? 'Start guided 360 capture'
                : 'Preview guided capture'}
          </button>
          <button className="capture-library-button" type="button" disabled={interactionBusy} onClick={() => onOpenPicker('manual', 'library')}>
            <CaptureIcon name="image" />
            Choose finished panorama
          </button>
          <button className="capture-manual-panel__daily" type="button" disabled={interactionBusy} onClick={() => onOpenPicker('manual', 'camera')}>
            Use the phone camera instead
          </button>
          <p className="capture-camera-note">
            {guidedCaptureAvailable
              ? 'Captured frames stay in the app’s temporary storage while your sphere is assembled.'
              : 'This browser shows the interaction preview. Install the Capacitor app on your phone for live camera and motion capture.'}
          </p>
          <button className="capture-manual-panel__daily" type="button" disabled={interactionBusy} onClick={onDailyMode}>
            Go to today’s moment
          </button>
        </section>
      ) : (
        <>
          <section className={`ks-card capture-window capture-window--${phase}`} aria-labelledby="capture-window-title">
            <div className="capture-window__copy">
              <h2 id="capture-window-title">{phaseCopy.title}</h2>
              <p>{phaseCopy.body}</p>
            </div>

            {canUseDailyWindow ? (
              <button
                className="ks-primary-button capture-window__action"
                type="button"
                disabled={interactionBusy}
                onClick={() => void onGuidedCapture('daily')}
              >
                <CaptureIcon name="camera" />
                Capture today in 360°
              </button>
            ) : (
              <div className="capture-window__locked" role="status">
                <span>{phase === 'upcoming' ? 'Today’s moment is locked' : phase === 'complete' ? 'Today’s moment is shared' : 'Today’s moment has closed'}</span>
              </div>
            )}
          </section>

          <button
            className="capture-manual-entry"
            type="button"
            aria-label="Upload a 360 photo now"
            disabled={interactionBusy}
            onClick={() => onOpenPicker('manual', 'library')}
          >
            <span className="capture-manual-entry__icon"><CaptureIcon name="image" /></span>
            <span>
              <strong>Share a 360 anytime</strong>
            </span>
            <span aria-hidden="true">›</span>
          </button>

          <details className="capture-prototype-note">
            <summary>Today’s window</summary>
            <p>
              {connectedFamilySync
                ? `${timeFormatter.format(captureWindow.startsAt)}–${timeFormatter.format(captureWindow.endsAt)} for everyone in your circle.`
                : `${timeFormatter.format(captureWindow.startsAt)}–${timeFormatter.format(captureWindow.endsAt)} on this device. Family Sync keeps the same time on everyone’s phone.`}
            </p>
          </details>
        </>
      )}

      {checking || guidedCaptureRunning ? (
        <p className="capture-checking" role="status">
          {guidedCaptureStatus || 'Preparing the 360° frame…'}
        </p>
      ) : null}
      {error ? <p className="capture-error" role="alert">{error}</p> : null}

      <details className="capture-prototype-note capture-photo-help">
        <summary>About 360 photos</summary>
        <p>Guided capture photographs overlapping views around you, including above and below, then projects them onto one 2:1 sphere. A finished 360 camera image can still be imported here.</p>
      </details>
    </>
  )
}
