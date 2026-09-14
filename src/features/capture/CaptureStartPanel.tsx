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
  nativeRecovery?: boolean
  hasPendingCapture?: boolean
  computerAssembly?: boolean
  enhancedAssemblyAvailable?: boolean
  assemblyMode?: 'standard' | 'advanced'
  advancedNativeAssembly?: boolean
  offlineAssemblyAvailable?: boolean
  nativeProgress?: { stage: string; progress: number } | null
  aiProgress?: { total: number; completed: number } | null
  sharedAssembling?: boolean
  aiAssembling?: boolean
  onNewCapture?: () => void
  onChooseAiPhotos?: () => void
  onStopSharedAssembly?: () => void
  onStopAiAssembly?: () => void
  onOpenAiGeneration?: () => void
  onOpenAdvancedAssembly?: () => void
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
  nativeRecovery = false, hasPendingCapture = false, computerAssembly = false,
  enhancedAssemblyAvailable = false, assemblyMode = 'standard',
  advancedNativeAssembly = false, offlineAssemblyAvailable = false,
  nativeProgress, aiProgress, sharedAssembling = false, aiAssembling = false,
  onNewCapture, onChooseAiPhotos, onStopSharedAssembly, onStopAiAssembly,
  onOpenAiGeneration, onOpenAdvancedAssembly,
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
            <li><span>1</span><p><strong>Keep the lens in one place</strong>Turn the phone around its camera lens. Give nearby objects some space.</p></li>
            <li><span>2</span><p><strong>Follow the dots</strong>{nativeRecovery ? 'Capture 34 main views. If your camera leaves small gaps, a few extra dots will appear.' : 'Turn slowly through the middle, ceiling, and floor.'}</p></li>
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
              : hasPendingCapture
                ? 'Retry assembly from saved photos'
              : guidedCaptureAvailable
                ? 'Start guided 360 capture'
                : 'Preview guided capture'}
          </button>
          {hasPendingCapture ? <button className="capture-library-button" type="button" disabled={interactionBusy} onClick={onNewCapture}>Start a new capture</button> : null}
          <button className="capture-library-button" type="button" disabled={interactionBusy} onClick={() => onOpenPicker('manual', 'library')}>
            <CaptureIcon name="image" />
            Choose finished panorama
          </button>
          <button className="capture-manual-panel__daily" type="button" disabled={interactionBusy} onClick={() => onOpenPicker('manual', 'camera')}>
            Use the phone camera instead
          </button>
          <p className="capture-camera-note">
            {guidedCaptureAvailable
              ? 'Your original photos are kept on this device, including after saving or sharing. Remove them only when you are happy with the sphere.'
              : 'This browser shows the interaction preview. Install the Capacitor app on your phone for live camera and motion capture.'}
          </p>
          {computerAssembly && enhancedAssemblyAvailable && guidedCaptureAvailable ? (
            <p className="capture-camera-note">Enhanced stitching is ready. Original photos will be sent to your stitching computer after capture.</p>
          ) : null}
          {assemblyMode === 'standard' ? <p className="capture-camera-note capture-camera-note--offline">
            Assembles on this phone using the shared panorama blend. No computer or AI model is needed. Keep Capture open while it joins your views.
          </p> : advancedNativeAssembly ? <p className="capture-camera-note capture-camera-note--offline">
            {offlineAssemblyAvailable
              ? 'Assembles on this phone. No connection to a computer is needed.'
              : 'Original photos stay on this phone. Assembly will be available when the on-phone engine is ready.'}
          </p> : null}
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

      {computerAssembly ? <section className="capture-ai-import" aria-labelledby="ai-import-title">
        <div>
          <span className="capture-ai-import__badge">AI assembly</span>
          <h2 id="ai-import-title">Build from your photos</h2>
          <p>Choose 8–64 overlapping JPEG photos taken from one spot, covering all directions, the ceiling, and the floor.</p>
        </div>
        <button className="ks-secondary-button" type="button" disabled={interactionBusy} onClick={() => onChooseAiPhotos?.()}>
          <CaptureIcon name="image" />
          Choose source photos
        </button>
        <p className="capture-ai-import__note">Originals are sent to your stitching computer for alignment. Missing views or moving subjects can still leave gaps. An already assembled 360 JPG cannot recover its original detail.</p>
      </section> : null}

      {checking || guidedCaptureRunning ? (
        <div className="capture-assembly-progress" aria-busy="true">
          <p className="capture-checking" role="status">{guidedCaptureStatus || 'Preparing the 360° frame…'}</p>
          {nativeProgress ? <>
            <ol className="capture-assembly-stages" aria-label="Assembly stages">
              {[
                { label: 'Match', stages: ['queued', 'preparing', 'loading', 'reading', 'features', 'matching'] },
                { label: 'Align', stages: ['aligning', 'alignment', 'optimizing', 'projecting'] },
                { label: 'Blend', stages: ['seams', 'blending'] },
                { label: 'Check', stages: ['checking', 'validating', 'encoding', 'saving', 'completed'] },
              ].map((step) => <li key={step.label} aria-current={step.stages.includes(nativeProgress.stage) ? 'step' : undefined}>{step.label}</li>)}
            </ol>
            <progress aria-label="Sphere assembly on this phone" value={nativeProgress.progress} max={1} />
            <p className="capture-ai-import__note">Your original photos stay safe. You can leave Capture while this phone finishes assembly.</p>
          </> : null}
          {aiProgress && aiProgress.total > 0 ? <progress aria-label="Current assembly step" value={aiProgress.completed} max={aiProgress.total} /> : null}
          {sharedAssembling ? <>
            <p className="capture-ai-import__note">Keep Capture open while your phone blends the views. Leaving this screen stops assembly; your original photos are kept for retry.</p>
            <button className="capture-manual-panel__daily" type="button" onClick={() => onStopSharedAssembly?.()}>Stop assembly</button>
          </> : null}
          {aiAssembling ? <button className="capture-manual-panel__daily" type="button" onClick={() => onStopAiAssembly?.()}>Stop assembly</button> : null}
        </div>
      ) : null}
      {error ? <p className="capture-error" role="alert">{error}</p> : null}

      {onOpenAiGeneration || (assemblyMode !== 'advanced' && onOpenAdvancedAssembly) ? (
        <details className="capture-prototype-note">
          <summary>Other creation options</summary>
          {onOpenAdvancedAssembly && assemblyMode !== 'advanced' ? <button className="capture-library-button" type="button" disabled={interactionBusy} onClick={onOpenAdvancedAssembly}>Advanced alignment</button> : null}
          {onOpenAiGeneration ? <button className="capture-library-button" type="button" disabled={interactionBusy} onClick={onOpenAiGeneration}>AI-generated scene on your computer</button> : null}
          <p>Advanced alignment may reject difficult photos. Computer generation invents missing scene content; neither option is needed for standard phone capture.</p>
        </details>
      ) : null}

      <details className="capture-prototype-note capture-photo-help">
        <summary>About 360 photos</summary>
        <p>Guided capture photographs overlapping views around you, including above and below, then projects them onto one 2:1 sphere. A finished 360 camera image can still be imported here.</p>
      </details>
    </>
  )
}
