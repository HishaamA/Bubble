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
  validateEquirectangularDimensions,
  type ImageDimensions,
} from './equirectangular'

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
      eyebrow: 'The family window is open',
      title: 'Capture this moment',
      body: 'You have one shared window and one panorama. Choose a ready 360° photo before time runs out.',
    }
  }

  if (phase === 'closed') {
    return {
      eyebrow: 'Today’s window has closed',
      title: 'One moment tomorrow',
      body: 'The daily family prompt is finished for today. A new surprise window will be scheduled tomorrow.',
    }
  }

  if (phase === 'complete') {
    return {
      eyebrow: 'Shared today',
      title: 'Your moment is in',
      body: 'You used today’s one-photo family window. Everyone gets another surprise moment tomorrow.',
    }
  }

  return {
    eyebrow: 'Today’s moment is locked',
    title: 'It could happen anytime',
    body: 'Once today, everyone gets the same short window to share one panorama with the family.',
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
  const fileInputRef = useRef<HTMLInputElement>(null)
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
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function openPicker(nextSource: CaptureSource) {
    if (nextSource === 'daily' && !canUseDailyWindow) return
    sourceRef.current = nextSource
    setSource(nextSource)
    setShared(false)
    setError('')
    fileInputRef.current?.click()
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
      const validation = validateEquirectangularDimensions(dimensions)

      if (!validation.valid) {
        setError(validation.message)
        setAnnouncement(validation.message)
        return
      }

      const previewUrl = URL.createObjectURL(file)
      previewUrlRef.current = previewUrl
      setSource(selectedSource)
      setDraft({
        file,
        dimensions,
        previewUrl,
        source: selectedSource,
        warning: validation.warning,
      })
      setAnnouncement(`${file.name} is ready to preview and share.`)
    } catch {
      const message = 'We could not open this image. Try another 360° panorama.'
      setError(message)
      setAnnouncement(message)
    } finally {
      setChecking(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
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
          <p className="eyebrow">One shared point in time</p>
          <h1 id="capture-title">360 Moment</h1>
        </div>
        {onClose ? (
          <button className="ks-feature__header-action" type="button" aria-label="Close 360 capture" onClick={onClose}>
            <CaptureIcon name="close" />
          </button>
        ) : <span className="capture-page__daily-badge">Daily</span>}
      </header>

      <p className="screen-reader-only" aria-live="polite">{announcement}</p>

      {isSuccess ? (
        <section className="ks-card capture-success" aria-labelledby="capture-success-title">
          <span className="capture-success__icon"><CaptureIcon name="check" /></span>
          <p className="eyebrow">Moment ready</p>
          <h2 id="capture-success-title">{onShare ? 'Sent to Memories' : 'Local preview saved'}</h2>
          <p>{successMessage ?? (onShare
            ? 'Your family can open this panorama from their Memories view.'
            : 'This MVP keeps the share only for this session until a family backend is connected.')}</p>
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
              Upload another 360
            </button>
          </div>
        </section>
      ) : draft ? (
        <form className="capture-editor" onSubmit={shareCapture}>
          <div className="capture-preview">
            <img src={draft.previewUrl} alt="Preview of selected 360 panorama" />
            <span className="capture-preview__badge">2:1 panorama</span>
            <button type="button" aria-label="Remove selected panorama" onClick={clearDraft}>
              <CaptureIcon name="close" />
            </button>
          </div>

          <div className="capture-editor__meta">
            <span>{draft.dimensions.width} × {draft.dimensions.height}</span>
            <span>{draft.source === 'daily' ? 'Daily moment' : 'Upload now'}</span>
          </div>

          {draft.warning ? <p className="capture-quality-note">{draft.warning}</p> : null}

          <label className="ks-field">
            <span>Add a caption <small>optional</small></span>
            <textarea
              value={caption}
              maxLength={160}
              placeholder="Dinner on the balcony with everyone…"
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
              ? 'Approved family members will receive this as a new bubble in Memories.'
              : 'This device will add the panorama to Memories. Connect a Family Circle to send it to other phones.'}
          </p>
        </form>
      ) : (
        <>
          {source === 'manual' ? (
            <section className="ks-card capture-manual-panel" aria-labelledby="manual-upload-title">
              <span className="capture-manual-panel__icon"><CaptureIcon name="image" /></span>
              <p className="eyebrow">Available anytime</p>
              <h2 id="manual-upload-title">Upload a 360 now</h2>
              <p>Choose a ready equirectangular panorama from a 360 camera or your photo library.</p>
              <button className="ks-primary-button" type="button" onClick={() => openPicker('manual')}>
                <CaptureIcon name="camera" />
                Open camera or library
              </button>
              <button className="capture-manual-panel__daily" type="button" onClick={() => {
                sourceRef.current = 'daily'
                setSource('daily')
                setError('')
              }}>
                View today’s daily prompt
              </button>
            </section>
          ) : (
            <>
              <section className={`ks-card capture-window capture-window--${phase}`} aria-labelledby="capture-window-title">
                <div className="capture-window__status">
                  <span className="capture-window__orb" aria-hidden="true">
                    <span><CaptureIcon name={phase === 'open' ? 'camera' : phase === 'complete' ? 'check' : 'lock'} /></span>
                  </span>
                  <span className="capture-window__pulse" aria-hidden="true" />
                </div>
                <div className="capture-window__copy">
                  <p className="eyebrow">{phaseCopy.eyebrow}</p>
                  <h2 id="capture-window-title">{phaseCopy.title}</h2>
                  <p>{phaseCopy.body}</p>
                </div>

                <dl className="capture-window__facts">
                  <div>
                    <dt>Today</dt>
                    <dd>{phase === 'open' ? 'Open now' : phase === 'complete' ? 'Completed' : 'Surprise time'}</dd>
                  </div>
                  <div>
                    <dt>Window</dt>
                    <dd>{Math.round((captureWindow.endsAt.getTime() - captureWindow.startsAt.getTime()) / 60_000)} minutes</dd>
                  </div>
                  <div>
                    <dt>Limit</dt>
                    <dd>One photo</dd>
                  </div>
                </dl>

                {canUseDailyWindow ? (
                  <button className="ks-primary-button capture-window__action" type="button" onClick={() => openPicker('daily')}>
                    <CaptureIcon name="camera" />
                    Choose today’s 360
                  </button>
                ) : (
                  <div className="capture-window__locked" role="status">
                    <CaptureIcon name={phase === 'complete' ? 'check' : 'lock'} />
                    <span>{phase === 'upcoming' ? 'Daily capture locked' : phase === 'complete' ? 'Daily capture complete' : 'Daily capture closed'}</span>
                  </div>
                )}
              </section>

              <button
                className="capture-manual-entry"
                type="button"
                aria-label="Upload a 360 photo now"
                onClick={() => openPicker('manual')}
              >
                <span className="capture-manual-entry__icon"><CaptureIcon name="image" /></span>
                <span>
                  <small>Don’t want to wait?</small>
                  <strong>Upload a 360 photo now</strong>
                </span>
                <span aria-hidden="true">›</span>
              </button>

              <details className="capture-prototype-note">
                <summary>About the random window</summary>
                <p>
                  {connectedFamilySync
                    ? `Your Family Circle shares this server-time window: ${timeFormatter.format(captureWindow.startsAt)}–${timeFormatter.format(captureWindow.endsAt)} today.`
                    : `This local preview calculates a stable demo window on this device: ${timeFormatter.format(captureWindow.startsAt)}–${timeFormatter.format(captureWindow.endsAt)} today. Connect a Family Circle so every member receives the same server-time window.`}
                </p>
              </details>
            </>
          )}

          {checking ? <p className="capture-checking" role="status">Checking panorama shape…</p> : null}
          {error ? <p className="capture-error" role="alert">{error}</p> : null}

          <aside className="capture-howto" aria-labelledby="capture-howto-title">
            <span className="capture-howto__icon"><CaptureIcon name="camera" /></span>
            <div>
              <h2 id="capture-howto-title">What counts as a 360 photo?</h2>
              <p>Use a 360 camera or select an existing 2:1 equirectangular panorama. A normal phone camera does not capture a complete 360° scene by itself.</p>
            </div>
          </aside>
        </>
      )}

      <input
        ref={fileInputRef}
        className="capture-file-input"
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Choose a 360 photo from camera or library"
        onChange={(event) => void selectFile(event)}
      />
    </section>
  )
}
