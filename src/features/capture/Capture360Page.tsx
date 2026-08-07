import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import '../FeaturePages.css'
import './Capture360Page.css'
import {
  createDailyCaptureWindow,
  getDailyCapturePhase,
  type DailyCapturePhase,
  type DailyCaptureWindow,
} from './captureWindow'
import {
  readImageDimensions,
  validatePanoramaCaptureDimensions,
  type ImageDimensions,
} from './equirectangular'
import {
  processPanoramaForSharing,
  type ProcessedPanorama,
} from '../../services/media/processPanorama'
import type { StoredPanoramaAnnotation } from '../memories/shared'
import {
  composeGuidedPanorama,
  type GuidedPanoramaProgress,
} from '../../services/media/composeGuidedPanorama'
import { GuidedCapturePreview } from './GuidedCapturePreview'
import { GuidedPanoramaReview } from './GuidedPanoramaReview'
import {
  discardNativePanoramaCapture,
  isNativeCaptureCancellation,
  isNativePanoramaCaptureAvailable,
  startNativePanoramaCapture,
  type NativePanoramaCaptureResult,
} from './nativePanoramaCapture'

export type CaptureSource = 'daily' | 'manual'

export type Capture360Submission = {
  id: string
  file: File
  caption: string
  source: CaptureSource
  width: number
  height: number
  createdAt: Date
  annotations: StoredPanoramaAnnotation[]
}

type Capture360PageProps = {
  now?: Date
  dailyWindow?: DailyCaptureWindow
  familySeed?: string
  dailyCaptureCompleted?: boolean
  initialMode?: CaptureSource
  connectedFamilySync?: boolean
  onClose?: () => void
  onViewMemories?: () => void
  onShare?: (submission: Capture360Submission) => void | Promise<void>
  readDimensions?: (file: File) => Promise<ImageDimensions>
  processPanorama?: (file: File) => Promise<ProcessedPanorama>
  guidedCaptureAvailable?: boolean
  startGuidedCapture?: () => Promise<NativePanoramaCaptureResult>
  discardGuidedCapture?: (result: NativePanoramaCaptureResult) => Promise<void>
  composeGuidedCapture?: (
    result: NativePanoramaCaptureResult,
    onProgress?: (progress: GuidedPanoramaProgress) => void,
  ) => Promise<ProcessedPanorama>
  successMessage?: string
}

type CaptureDraft = {
  file: File
  dimensions: ImageDimensions
  previewUrl: string
  source: CaptureSource
  origin: 'guided' | 'upload'
  warning?: string
}

const timeFormatter = new Intl.DateTimeFormat('en', {
  hour: 'numeric',
  minute: '2-digit',
})

function CaptureIcon({ name }: { name: 'close' | 'lock' | 'camera' | 'check' | 'image' }) {
  const common = {
    'aria-hidden': true,
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }

  if (name === 'close') return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>
  if (name === 'check') return <svg {...common}><path d="m5 12.5 4.3 4.3L19 7" /></svg>
  if (name === 'image') return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="m4 17 4.5-4 3.4 3 2.8-2.5L20 18" /></svg>
  if (name === 'camera') return <svg {...common}><path d="M4.5 7.5h3l1.4-2h6.2l1.4 2h3A2.5 2.5 0 0 1 22 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5V10a2.5 2.5 0 0 1 2.5-2.5Z" /><circle cx="12" cy="13.5" r="3.4" /></svg>
  return <svg {...common}><rect x="5" y="10" width="14" height="10" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
}

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

function makeSubmissionId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
      const random = Math.floor(Math.random() * 16)
      const value = character === 'x' ? random : (random & 0x3) | 0x8
      return value.toString(16)
    })
  )
}

export function Capture360Page({
  now,
  dailyWindow,
  familySeed,
  dailyCaptureCompleted = false,
  initialMode = 'daily',
  connectedFamilySync = false,
  onClose,
  onViewMemories,
  onShare,
  readDimensions = readImageDimensions,
  processPanorama = processPanoramaForSharing,
  guidedCaptureAvailable = isNativePanoramaCaptureAvailable(),
  startGuidedCapture = startNativePanoramaCapture,
  discardGuidedCapture = discardNativePanoramaCapture,
  composeGuidedCapture = composeGuidedPanorama,
  successMessage,
}: Capture360PageProps) {
  const [clock, setClock] = useState(() => new Date())
  const [source, setSource] = useState<CaptureSource>(initialMode)
  const [draft, setDraft] = useState<CaptureDraft | null>(null)
  const [caption, setCaption] = useState('')
  const [annotations, setAnnotations] = useState<StoredPanoramaAnnotation[]>([])
  const [reviewingGuidedCapture, setReviewingGuidedCapture] = useState(false)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [shared, setShared] = useState(false)
  const [completedDaily, setCompletedDaily] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [guidePreview, setGuidePreview] = useState(false)
  const [guidedCaptureRunning, setGuidedCaptureRunning] = useState(false)
  const [guidedCaptureStatus, setGuidedCaptureStatus] = useState('')
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const libraryInputRef = useRef<HTMLInputElement>(null)
  const sourceRef = useRef<CaptureSource>(initialMode)
  const previewUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (now) return

    const timer = window.setInterval(() => setClock(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [now])

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  const currentTime = now ?? clock
  const captureWindow = useMemo(
    () => dailyWindow ?? createDailyCaptureWindow(currentTime, familySeed),
    [currentTime, dailyWindow, familySeed],
  )
  const dailyCompleted = dailyCaptureCompleted || completedDaily
  const phase = getDailyCapturePhase(currentTime, captureWindow, dailyCompleted)
  const phaseCopy = getPhaseCopy(phase)
  const canUseDailyWindow = phase === 'open'
  const isSuccess = shared

  function clearDraft() {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setDraft(null)
    setCaption('')
    setAnnotations([])
    setReviewingGuidedCapture(false)
    setError('')
    if (cameraInputRef.current) cameraInputRef.current.value = ''
    if (libraryInputRef.current) libraryInputRef.current.value = ''
  }

  function openPicker(
    nextSource: CaptureSource,
    picker: 'camera' | 'library' = 'library',
  ) {
    if (nextSource === 'daily' && !canUseDailyWindow) return
    sourceRef.current = nextSource
    setSource(nextSource)
    setShared(false)
    setError('')
    const input = picker === 'camera' ? cameraInputRef : libraryInputRef
    input.current?.click()
  }

  function installDraft(
    file: File,
    dimensions: ImageDimensions,
    selectedSource: CaptureSource,
    origin: CaptureDraft['origin'],
    warning?: string,
  ) {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    const previewUrl = URL.createObjectURL(file)
    previewUrlRef.current = previewUrl
    setSource(selectedSource)
    setDraft({
      file,
      dimensions,
      previewUrl,
      source: selectedSource,
      origin,
      warning,
    })
    setAnnotations([])
    setReviewingGuidedCapture(origin === 'guided')
  }

  async function beginGuidedCapture(nextSource: CaptureSource) {
    if (nextSource === 'daily' && !canUseDailyWindow) return
    sourceRef.current = nextSource
    setSource(nextSource)
    setShared(false)
    setError('')

    if (!guidedCaptureAvailable) {
      setGuidePreview(true)
      setAnnouncement('Opened the guided capture preview.')
      return
    }

    setGuidedCaptureRunning(true)
    setGuidedCaptureStatus('Opening the camera guide…')
    let captureResult: NativePanoramaCaptureResult | undefined
    try {
      const result = await startGuidedCapture()
      captureResult = result
      if (
        result.frames.length < result.targetCount ||
        result.capturedCount < result.targetCount
      ) {
        throw new Error('Capture every surrounding dot before finishing.')
      }

      setGuidedCaptureStatus('Building your 360° moment…')
      const processed = await composeGuidedCapture(result, (progress) => {
        if (progress.phase === 'reading') {
          setGuidedCaptureStatus(`Reading view ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}…`)
        } else if (progress.phase === 'projecting') {
          setGuidedCaptureStatus(`Joining view ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}…`)
        } else {
          setGuidedCaptureStatus('Finishing your 360° moment…')
        }
      })
      const file = new File(
        [processed.viewer],
        `kinsphere-${new Date().toISOString().replace(/[:.]/g, '-')}-360.jpg`,
        { type: 'image/jpeg', lastModified: Date.now() },
      )
      installDraft(
        file,
        { width: processed.viewerWidth, height: processed.viewerHeight },
        nextSource,
        'guided',
        `Built from ${result.capturedCount} overlapping views around you.`,
      )
      setAnnouncement('Your guided 360° moment is ready to review.')
    } catch (captureError) {
      if (!isNativeCaptureCancellation(captureError)) {
        const message = captureError instanceof Error
          ? captureError.message
          : 'The guided capture could not be completed. Your family has not received anything yet.'
        setError(message)
        setAnnouncement(message)
      }
    } finally {
      if (captureResult) {
        try {
          await discardGuidedCapture(captureResult)
        } catch {
          // Cache directories are OS-evictable; cleanup failure must not throw
          // away the finished, already-sanitized panorama.
        }
      }
      setGuidedCaptureRunning(false)
      setGuidedCaptureStatus('')
    }
  }

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    clearDraft()
    const selectedSource = sourceRef.current

    if (!file.type.startsWith('image/')) {
      setError('Choose an image file from your camera or photo library.')
      setAnnouncement('The selected file is not an image.')
      return
    }

    if (file.size > 25 * 1024 * 1024) {
      const message = 'Choose a 360° panorama smaller than 25 MB.'
      setError(message)
      setAnnouncement(message)
      return
    }

    setChecking(true)
    try {
      const dimensions = await readDimensions(file)
      const validation = validatePanoramaCaptureDimensions(dimensions)

      if (!validation.valid) {
        setError(validation.message)
        setAnnouncement(validation.message)
        return
      }

      let preparedFile = file
      let preparedDimensions = dimensions
      if (validation.needsNormalization) {
        const processed = await processPanorama(file)
        const filename = file.name.replace(/\.[^.]+$/, '') || 'family-panorama'
        preparedFile = new File(
          [processed.viewer],
          `${filename}-360.jpg`,
          { type: 'image/jpeg', lastModified: file.lastModified },
        )
        preparedDimensions = {
          width: processed.viewerWidth,
          height: processed.viewerHeight,
        }
      }

      installDraft(
        preparedFile,
        preparedDimensions,
        selectedSource,
        'upload',
        validation.warning,
      )
      setAnnouncement(
        validation.needsNormalization
          ? `${file.name} was fitted to a 360-degree frame and is ready to share.`
          : `${file.name} is ready to preview and share.`,
      )
    } catch {
      const message = 'We could not open this image. Try another 360° panorama.'
      setError(message)
      setAnnouncement(message)
    } finally {
      setChecking(false)
      event.target.value = ''
    }
  }

  async function shareCapture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft || sharing) return

    setSharing(true)
    setError('')
    try {
      await onShare?.({
        id: makeSubmissionId(),
        file: draft.file,
        caption: caption.trim(),
        source: draft.source,
        width: draft.dimensions.width,
        height: draft.dimensions.height,
        createdAt: new Date(),
        annotations,
      })
      if (draft.source === 'daily') setCompletedDaily(true)
      setShared(true)
      setAnnouncement(successMessage ?? (onShare
        ? 'Your 360° moment was sent to Memories.'
        : 'Your 360° moment is saved in this local preview.'))
    } catch {
      const message = 'This panorama could not be shared. Your preview is still here, so you can try again.'
      setError(message)
      setAnnouncement(message)
    } finally {
      setSharing(false)
    }
  }

  if (guidePreview) {
    return <GuidedCapturePreview onClose={() => setGuidePreview(false)} />
  }

  return (
    <section className="ks-feature capture-page" aria-labelledby="capture-title">
      <header className="ks-feature__header capture-page__header">
        <div className="ks-feature__header-copy">
          <h1 id="capture-title">360 Moment</h1>
        </div>
        {onClose ? (
          <button className="ks-feature__header-action" type="button" aria-label="Close 360 capture" onClick={onClose}>
            <CaptureIcon name="close" />
          </button>
        ) : null}
      </header>

      <p className="screen-reader-only" aria-live="polite">{announcement}</p>

      {isSuccess ? (
        <section className="ks-card capture-success" aria-labelledby="capture-success-title">
          <span className="capture-success__icon"><CaptureIcon name="check" /></span>
          <h2 id="capture-success-title">{onShare ? 'Shared with family' : 'Saved to Memories'}</h2>
          <p>{successMessage ?? (onShare
            ? 'Everyone in your circle can find it in Memories.'
            : 'It’s in Memories on this device.')}</p>
          {draft ? <img src={draft.previewUrl} alt="Shared 360 panorama preview" /> : null}
          <div className="capture-success__actions">
            {onViewMemories ? (
              <button
                className="ks-primary-button"
                type="button"
                onClick={onViewMemories}
              >
                View in Memories
              </button>
            ) : null}
            <button className="ks-secondary-button" type="button" onClick={() => {
              clearDraft()
              setShared(false)
              sourceRef.current = 'manual'
              setSource('manual')
            }}>
              Share another
            </button>
          </div>
        </section>
      ) : draft && reviewingGuidedCapture ? (
        <GuidedPanoramaReview
          panoramaUrl={draft.previewUrl}
          annotations={annotations}
          onAnnotationsChange={setAnnotations}
          onContinue={() => {
            setReviewingGuidedCapture(false)
            setAnnouncement(
              annotations.length > 0
                ? `${annotations.length} memory ${annotations.length === 1 ? 'point is' : 'points are'} ready to share.`
                : 'Your 360° review is complete. Add a title, then share it.',
            )
          }}
          onRetake={() => {
            const captureSource = draft.source
            clearDraft()
            void beginGuidedCapture(captureSource)
          }}
        />
      ) : draft ? (
        <form className="capture-editor" onSubmit={shareCapture}>
          <div className="capture-preview">
            <img src={draft.previewUrl} alt="Preview of selected 360 panorama" />
            <button type="button" aria-label="Remove selected panorama" onClick={clearDraft}>
              <CaptureIcon name="close" />
            </button>
          </div>

          {draft.warning ? <p className="capture-quality-note">{draft.warning}</p> : null}

          {annotations.length > 0 ? (
            <p className="capture-quality-note">
              {annotations.length} memory {annotations.length === 1 ? 'point' : 'points'} will appear inside this 360° moment.
            </p>
          ) : null}

          <label className="ks-field">
            <span>Moment title <small>optional · above the bubble</small></span>
            <textarea
              value={caption}
              maxLength={160}
              placeholder="Dinner together on the balcony…"
              onChange={(event) => setCaption(event.target.value)}
            />
          </label>

          {error ? <p className="capture-error" role="alert">{error}</p> : null}

          <button className="ks-primary-button" type="submit" disabled={sharing}>
            <CaptureIcon name="check" />
            {sharing ? 'Sharing…' : 'Share with family'}
          </button>
          <p className="ks-inline-note">
            {connectedFamilySync
              ? 'Everyone in your circle will find it in Memories.'
              : 'It’ll be saved to Memories on this device.'}
          </p>
        </form>
      ) : (
        <>
          {source === 'manual' ? (
            <section className="ks-card capture-manual-panel" aria-labelledby="manual-upload-title">
              <h2 id="manual-upload-title">Capture every direction</h2>
              <p>KinSphere places a quiet field of dots around you and takes each view automatically when your phone is lined up and still.</p>
              <ol className="capture-panorama-steps" aria-label="How guided 360 capture works">
                <li><span>1</span><p><strong>Stand in one place</strong>Keep the phone close to where your head will be in VR.</p></li>
                <li><span>2</span><p><strong>Follow the dots</strong>Turn slowly through the middle, ceiling, and floor.</p></li>
                <li><span>3</span><p><strong>Hold for a moment</strong>Each aligned view captures itself—no shutter tapping.</p></li>
              </ol>
              <button
                className="ks-primary-button"
                type="button"
                disabled={guidedCaptureRunning}
                onClick={() => void beginGuidedCapture('manual')}
              >
                <CaptureIcon name="camera" />
                {guidedCaptureRunning
                  ? 'Preparing capture…'
                  : guidedCaptureAvailable
                    ? 'Start guided 360 capture'
                    : 'Preview guided capture'}
              </button>
              <button className="capture-library-button" type="button" onClick={() => openPicker('manual', 'library')}>
                <CaptureIcon name="image" />
                Choose finished panorama
              </button>
              <button className="capture-manual-panel__daily" type="button" onClick={() => openPicker('manual', 'camera')}>
                Use the phone camera instead
              </button>
              <p className="capture-camera-note">
                {guidedCaptureAvailable
                  ? 'Captured frames stay in the app’s temporary storage while your sphere is assembled.'
                  : 'This browser shows the interaction preview. Install the Capacitor app on your phone for live camera and motion capture.'}
              </p>
              <button className="capture-manual-panel__daily" type="button" onClick={() => {
                sourceRef.current = 'daily'
                setSource('daily')
                setError('')
              }}>
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
                    disabled={guidedCaptureRunning}
                    onClick={() => void beginGuidedCapture('daily')}
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
                onClick={() => openPicker('manual', 'library')}
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
      )}

      <input
        ref={cameraInputRef}
        className="capture-file-input"
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Take a panorama with camera"
        onChange={(event) => void selectFile(event)}
      />
      <input
        ref={libraryInputRef}
        className="capture-file-input"
        type="file"
        accept="image/*"
        aria-label="Choose a 360 photo from camera or library"
        onChange={(event) => void selectFile(event)}
      />
    </section>
  )
}
