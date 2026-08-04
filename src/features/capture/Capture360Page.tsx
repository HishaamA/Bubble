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

export type CaptureSource = 'daily' | 'manual'

export type Capture360Submission = {
  id: string
  file: File
  caption: string
  source: CaptureSource
  width: number
  height: number
  createdAt: Date
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
  successMessage?: string
}

type CaptureDraft = {
  file: File
  dimensions: ImageDimensions
  previewUrl: string
  source: CaptureSource
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
  successMessage,
}: Capture360PageProps) {
  const [clock, setClock] = useState(() => new Date())
  const [source, setSource] = useState<CaptureSource>(initialMode)
  const [draft, setDraft] = useState<CaptureDraft | null>(null)
  const [caption, setCaption] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [shared, setShared] = useState(false)
  const [completedDaily, setCompletedDaily] = useState(false)
  const [announcement, setAnnouncement] = useState('')
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

      const previewUrl = URL.createObjectURL(preparedFile)
      previewUrlRef.current = previewUrl
      setSource(selectedSource)
      setDraft({
        file: preparedFile,
        dimensions: preparedDimensions,
        previewUrl,
        source: selectedSource,
        warning: validation.warning,
      })
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
      ) : draft ? (
        <form className="capture-editor" onSubmit={shareCapture}>
          <div className="capture-preview">
            <img src={draft.previewUrl} alt="Preview of selected 360 panorama" />
            <button type="button" aria-label="Remove selected panorama" onClick={clearDraft}>
              <CaptureIcon name="close" />
            </button>
          </div>

          {draft.warning ? <p className="capture-quality-note">{draft.warning}</p> : null}

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
              <h2 id="manual-upload-title">Capture a 360 moment</h2>
              <p>Use your phone’s panorama mode, then we’ll fit the full sweep into a 360°-ready memory.</p>
              <ol className="capture-panorama-steps" aria-label="How to take a phone panorama">
                <li><span>1</span><p><strong>Turn sideways</strong>Hold your phone in landscape.</p></li>
                <li><span>2</span><p><strong>Choose Pano</strong>In Camera, use Pano or Panorama mode.</p></li>
                <li><span>3</span><p><strong>Sweep slowly</strong>Follow the guide in one steady direction.</p></li>
              </ol>
              <button className="ks-primary-button" type="button" onClick={() => openPicker('manual', 'camera')}>
                <CaptureIcon name="camera" />
                Take panoramic photo
              </button>
              <button className="capture-library-button" type="button" onClick={() => openPicker('manual', 'library')}>
                <CaptureIcon name="image" />
                Choose finished panorama
              </button>
              <p className="capture-camera-note">If Pano mode does not appear here, take it in your Camera app first, then choose it from Photos.</p>
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
                  <button className="ks-primary-button capture-window__action" type="button" onClick={() => openPicker('daily', 'camera')}>
                    <CaptureIcon name="camera" />
                    Take today’s panorama
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

          {checking ? <p className="capture-checking" role="status">Preparing the 360° frame…</p> : null}
          {error ? <p className="capture-error" role="alert">{error}</p> : null}

          <details className="capture-prototype-note capture-photo-help">
            <summary>About 360 photos</summary>
            <p>A wide phone panorama becomes a draggable 360° scene for this MVP. It wraps the horizontal sweep and extends its own edge pixels above and below; it does not invent areas your camera never captured.</p>
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
