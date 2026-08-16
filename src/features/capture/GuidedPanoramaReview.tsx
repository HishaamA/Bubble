import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  PanoramaViewer,
  type PanoramaHotSpot,
  type PanoramaScene,
} from '../../viewer'
import type { StoredPanoramaAnnotation } from '../memories/shared'
import {
  isVoiceNoteRecordingSupported,
  MAX_VOICE_NOTE_DURATION_MS,
  startVoiceNoteRecording,
  type RecordedVoiceNote,
  type VoiceNoteRecordingSession,
} from './voiceNoteRecorder'
import './GuidedPanoramaReview.css'

const MAX_POINTS = 8
const MAX_MESSAGE_LENGTH = 180

type SelectedPoint = {
  pitch: number
  yaw: number
}

type EditorStep = 'choose' | 'message' | 'voice'

export type GuidedPanoramaReviewProps = {
  panoramaUrl: string
  annotations: StoredPanoramaAnnotation[]
  onAnnotationsChange: (next: StoredPanoramaAnnotation[]) => void
  onContinue: () => void
  onRetake: () => void
  title?: string
  subtitle?: string
  retakeLabel?: string
  continueLabel?: string
  busy?: boolean
  actionError?: string | null
  actionMessage?: string | null
  hideRetake?: boolean
  modal?: boolean
}

function makePointId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `point-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

function formatDuration(durationMs: number) {
  const seconds = Math.min(60, Math.max(0, Math.floor(durationMs / 1000)))
  return `0:${seconds.toString().padStart(2, '0')}`
}

function meaningfulVoiceDescription(value: string) {
  const description = value.trim()
  if (/^(?:a )?voice note\.?$/i.test(description)) return ''
  return description
}

function shortenedPointMessage(message: string) {
  return message.length > 32 ? `${message.slice(0, 31)}…` : message
}

function pointLabel(annotation: StoredPanoramaAnnotation) {
  const message = annotation.message.trim()
  if (annotation.kind === 'voice') {
    const description = meaningfulVoiceDescription(message)
    return description
      ? `Voice: ${shortenedPointMessage(description)}`
      : 'Voice note'
  }
  return shortenedPointMessage(message) || 'Message'
}

function ReviewIcon({ name }: { name: 'plus' | 'message' | 'voice' | 'stop' }) {
  const common = {
    'aria-hidden': true,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }

  if (name === 'message') {
    return <svg {...common}><path d="M5 5.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4.5 3v-3H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" /></svg>
  }
  if (name === 'voice') {
    return <svg {...common}><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" /></svg>
  }
  if (name === 'stop') {
    return <svg {...common} fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
  }
  return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>
}

export function GuidedPanoramaReview({
  panoramaUrl,
  annotations,
  onAnnotationsChange,
  onContinue,
  onRetake,
  title = 'Review your 360°',
  subtitle = 'Drag to look around',
  retakeLabel = 'Retake',
  continueLabel = 'Continue',
  busy = false,
  actionError = null,
  actionMessage = null,
  hideRetake = false,
  modal = false,
}: GuidedPanoramaReviewProps) {
  const [placingPoint, setPlacingPoint] = useState(false)
  const [selectedPoint, setSelectedPoint] = useState<SelectedPoint | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editorStep, setEditorStep] = useState<EditorStep | null>(null)
  const [message, setMessage] = useState('')
  const [voiceClip, setVoiceClip] = useState<RecordedVoiceNote | null>(null)
  const [voicePreviewUrl, setVoicePreviewUrl] = useState<string | null>(null)
  const [voiceError, setVoiceError] = useState('')
  const [requestingMicrophone, setRequestingMicrophone] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordingElapsed, setRecordingElapsed] = useState(0)
  const recordingSessionRef = useRef<VoiceNoteRecordingSession | null>(null)
  const recordingClockRef = useRef<number | null>(null)
  const recordingRequestRef = useRef(0)
  const voicePreviewUrlRef = useRef<string | null>(null)
  const sheetRef = useRef<HTMLElement | null>(null)
  const reviewRef = useRef<HTMLElement | null>(null)
  const editorWasOpenRef = useRef(false)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const releaseVoicePreview = useCallback(() => {
    if (voicePreviewUrlRef.current) {
      URL.revokeObjectURL(voicePreviewUrlRef.current)
      voicePreviewUrlRef.current = null
    }
    setVoicePreviewUrl(null)
  }, [])

  const installVoicePreview = useCallback((blob: Blob) => {
    if (voicePreviewUrlRef.current) {
      URL.revokeObjectURL(voicePreviewUrlRef.current)
    }
    const nextUrl = URL.createObjectURL(blob)
    voicePreviewUrlRef.current = nextUrl
    setVoicePreviewUrl(nextUrl)
  }, [])

  const stopRecordingClock = useCallback(() => {
    if (recordingClockRef.current === null) return
    window.clearInterval(recordingClockRef.current)
    recordingClockRef.current = null
  }, [])

  const discardActiveRecording = useCallback(() => {
    recordingRequestRef.current += 1
    recordingSessionRef.current?.cancel()
    recordingSessionRef.current = null
    stopRecordingClock()
    setRequestingMicrophone(false)
    setRecording(false)
    setRecordingElapsed(0)
  }, [stopRecordingClock])

  const resetEditor = useCallback(() => {
    discardActiveRecording()
    releaseVoicePreview()
    setSelectedPoint(null)
    setEditingId(null)
    setEditorStep(null)
    setMessage('')
    setVoiceClip(null)
    setVoiceError('')
  }, [discardActiveRecording, releaseVoicePreview])

  useEffect(() => () => {
    recordingRequestRef.current += 1
    recordingSessionRef.current?.cancel()
    recordingSessionRef.current = null
    if (recordingClockRef.current !== null) {
      window.clearInterval(recordingClockRef.current)
      recordingClockRef.current = null
    }
    if (voicePreviewUrlRef.current) {
      URL.revokeObjectURL(voicePreviewUrlRef.current)
      voicePreviewUrlRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!modal) return
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const frame = window.requestAnimationFrame(() => reviewRef.current?.focus())

    return () => {
      window.cancelAnimationFrame(frame)
      previousFocus?.focus({ preventScroll: true })
    }
  }, [modal])

  useEffect(() => {
    const interruptRecording = () => {
      if (
        !requestingMicrophone &&
        !recording &&
        !recordingSessionRef.current
      ) {
        return
      }
      discardActiveRecording()
      releaseVoicePreview()
      setVoiceClip(null)
      setVoiceError(
        'Recording stopped when the app moved to the background. Record the voice note again.',
      )
    }
    const interruptWhenHidden = () => {
      if (document.visibilityState === 'hidden') interruptRecording()
    }

    document.addEventListener('visibilitychange', interruptWhenHidden)
    window.addEventListener('pagehide', interruptRecording)
    window.addEventListener('freeze', interruptRecording)
    return () => {
      document.removeEventListener('visibilitychange', interruptWhenHidden)
      window.removeEventListener('pagehide', interruptRecording)
      window.removeEventListener('freeze', interruptRecording)
    }
  }, [
    discardActiveRecording,
    recording,
    releaseVoicePreview,
    requestingMicrophone,
  ])

  useEffect(() => {
    const editorOpen = editorStep !== null
    if (editorOpen && !editorWasOpenRef.current) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      queueMicrotask(() => {
        const initialControl = sheetRef.current?.querySelector<HTMLElement>(
          'textarea, .guided-panorama-review__kind-picker button:not(:disabled), .guided-panorama-review__record:not(:disabled), .guided-panorama-review__cancel',
        )
        initialControl?.focus()
      })
    } else if (!editorOpen && editorWasOpenRef.current) {
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
    editorWasOpenRef.current = editorOpen
  }, [editorStep])

  const openAnnotation = useCallback((annotation: StoredPanoramaAnnotation) => {
    if (busy) return
    discardActiveRecording()
    releaseVoicePreview()
    setPlacingPoint(false)
    setSelectedPoint({ pitch: annotation.pitch, yaw: annotation.yaw })
    setEditingId(annotation.id)
    setEditorStep(annotation.kind === 'voice' ? 'voice' : 'message')
    setMessage(
      annotation.kind === 'voice'
        ? meaningfulVoiceDescription(annotation.message)
        : annotation.message,
    )
    setVoiceError(
      annotation.kind === 'voice' && !annotation.audioBlob
        ? 'This voice note audio is unavailable. Record it again before saving this point.'
        : '',
    )

    if (annotation.kind === 'voice' && annotation.audioBlob) {
      const clip = {
        blob: annotation.audioBlob,
        mimeType: annotation.audioMimeType || annotation.audioBlob.type || 'audio/webm',
        durationMs: annotation.durationMs ?? 0,
      }
      setVoiceClip(clip)
      installVoicePreview(clip.blob)
    } else {
      setVoiceClip(null)
    }
  }, [busy, discardActiveRecording, installVoicePreview, releaseVoicePreview])

  const hotSpots = useMemo<PanoramaHotSpot[]>(() =>
    annotations.map((annotation) => ({
      id: annotation.id,
      kind: annotation.kind === 'voice' ? 'audio' : 'info',
      pitch: annotation.pitch,
      yaw: annotation.yaw,
      label: pointLabel(annotation),
      onActivate: (event) => {
        event.stopPropagation()
        openAnnotation(annotation)
      },
    })), [annotations, openAnnotation])

  const scenes = useMemo<PanoramaScene[]>(() => [{
    id: 'capture-review',
    panorama: panoramaUrl,
    alt: 'Interactive preview of your captured 360 panorama',
    hotSpots,
    pitch: 0,
    yaw: 0,
    hfov: 104,
  }], [hotSpots, panoramaUrl])

  const handlePointSelect = useCallback((point: SelectedPoint) => {
    if (!placingPoint || annotations.length >= MAX_POINTS) return
    setPlacingPoint(false)
    setSelectedPoint(point)
    setEditingId(null)
    setEditorStep('choose')
    setMessage('')
    setVoiceClip(null)
    setVoiceError('')
    releaseVoicePreview()
  }, [annotations.length, placingPoint, releaseVoicePreview])

  const togglePointPlacement = () => {
    if (editorStep || annotations.length >= MAX_POINTS) return
    setPlacingPoint((current) => !current)
  }

  const beginVoiceRecording = async () => {
    if (requestingMicrophone || recording) return
    setVoiceError('')
    setRequestingMicrophone(true)
    const requestId = recordingRequestRef.current + 1
    recordingRequestRef.current = requestId

    try {
      const startedAt = Date.now()
      const session = await startVoiceNoteRecording({
        onComplete: (clip) => {
          if (recordingRequestRef.current !== requestId) return
          recordingSessionRef.current = null
          stopRecordingClock()
          setRecording(false)
          setRecordingElapsed(clip.durationMs)
          setVoiceClip(clip)
          installVoicePreview(clip.blob)
        },
        onError: (errorMessage) => {
          if (recordingRequestRef.current !== requestId) return
          recordingSessionRef.current = null
          stopRecordingClock()
          setRecording(false)
          setVoiceError(errorMessage)
        },
      })

      if (recordingRequestRef.current !== requestId) {
        session.cancel()
        return
      }

      recordingSessionRef.current?.cancel()
      recordingSessionRef.current = session
      releaseVoicePreview()
      setVoiceClip(null)
      setRequestingMicrophone(false)
      setRecording(true)
      setRecordingElapsed(0)
      recordingClockRef.current = window.setInterval(() => {
        setRecordingElapsed(
          Math.min(MAX_VOICE_NOTE_DURATION_MS, Date.now() - startedAt),
        )
      }, 250)
    } catch (reason) {
      if (recordingRequestRef.current !== requestId) return
      setRequestingMicrophone(false)
      setRecording(false)
      setVoiceError(
        reason instanceof Error && /compatible audio format/i.test(reason.message)
          ? reason.message
          : 'Microphone access was not allowed. Check your device settings and try again.',
      )
    }
  }

  const stopVoiceRecording = () => {
    recordingSessionRef.current?.stop()
  }

  const saveAnnotation = (kind: StoredPanoramaAnnotation['kind']) => {
    if (!selectedPoint) return
    const existing = editingId
      ? annotations.find((annotation) => annotation.id === editingId)
      : undefined
    let nextAnnotation: StoredPanoramaAnnotation

    if (kind === 'text') {
      const cleanMessage = message.trim()
      if (!cleanMessage) return
      nextAnnotation = {
        id: existing?.id ?? makePointId(),
        kind: 'text',
        ...selectedPoint,
        message: cleanMessage,
      }
    } else {
      const description = meaningfulVoiceDescription(message)
      if (
        !voiceClip ||
        !description ||
        description.length > MAX_MESSAGE_LENGTH
      ) return
      nextAnnotation = {
        id: existing?.id ?? makePointId(),
        kind: 'voice',
        ...selectedPoint,
        message: description,
        audioBlob: voiceClip.blob,
        audioMimeType: voiceClip.mimeType,
        durationMs: voiceClip.durationMs,
      }
    }

    const next = existing
      ? annotations.map((annotation) =>
        annotation.id === existing.id ? nextAnnotation : annotation)
      : [...annotations, nextAnnotation]
    onAnnotationsChange(next)
    resetEditor()
  }

  const deleteAnnotation = () => {
    if (!editingId) return
    onAnnotationsChange(
      annotations.filter((annotation) => annotation.id !== editingId),
    )
    resetEditor()
  }

  const handleRetake = () => {
    if (busy) return
    resetEditor()
    setPlacingPoint(false)
    onRetake()
  }

  const handleContinue = () => {
    if (busy) return
    resetEditor()
    setPlacingPoint(false)
    onContinue()
  }

  const voiceSupported = isVoiceNoteRecordingSupported()
  const voiceDescription = meaningfulVoiceDescription(message)
  const pointLimitReached = annotations.length >= MAX_POINTS
  const controlsLocked = editorStep !== null || busy

  return (
    <section
      ref={reviewRef}
      className={`guided-panorama-review${placingPoint ? ' is-placing-point' : ''}`}
      aria-labelledby="guided-panorama-review-title"
      aria-modal={modal || undefined}
      role={modal ? 'dialog' : undefined}
      tabIndex={modal ? -1 : undefined}
    >
      <PanoramaViewer
        className="guided-panorama-review__viewer"
        scenes={scenes}
        initialSceneId="capture-review"
        ariaLabel="Review your 360 panorama"
        showControls={false}
        pointSelectionEnabled={placingPoint}
        onPointSelect={handlePointSelect}
        onPointSelectionCancel={() => setPlacingPoint(false)}
      />

      <div className="guided-panorama-review__topbar">
        <div>
          <h1 id="guided-panorama-review-title">{title}</h1>
          <p>{subtitle}</p>
        </div>
        <span aria-label={`${annotations.length} of ${MAX_POINTS} memory points`}>
          {annotations.length}/{MAX_POINTS} points
        </span>
      </div>

      <p
        className="guided-panorama-review__status"
        role="status"
        aria-live="polite"
      >
        {actionError
          ? actionError
          : busy
            ? 'Saving your memory points…'
            : actionMessage
              ? actionMessage
              : placingPoint
                ? 'Tap the object where you want to leave a memory point.'
                : pointLimitReached
                  ? 'All 8 memory points are placed.'
                  : 'Add a message or voice note to anything in the moment.'}
      </p>

      <div
        className="guided-panorama-review__dock"
        role="group"
        aria-label="Review actions"
      >
        {hideRetake ? <span aria-hidden="true" /> : (
          <button
            className="guided-panorama-review__side-action"
            type="button"
            onClick={handleRetake}
            disabled={controlsLocked || placingPoint}
          >
            {retakeLabel}
          </button>
        )}
        <button
          className="guided-panorama-review__add"
          type="button"
          onClick={togglePointPlacement}
          disabled={controlsLocked || pointLimitReached}
          aria-label={placingPoint ? 'Cancel point placement' : 'Add a memory point'}
          aria-pressed={placingPoint}
        >
          <ReviewIcon name="plus" />
        </button>
        <button
          className="guided-panorama-review__side-action is-primary"
          type="button"
          onClick={handleContinue}
          disabled={controlsLocked || placingPoint}
        >
          {busy ? 'Saving…' : continueLabel}
        </button>
      </div>

      {editorStep ? (
        <div
          className="guided-panorama-review__sheet-layer"
          onKeyDown={(event) => {
            if (event.key === 'Escape') resetEditor()
          }}
        >
          <section
            ref={sheetRef}
            className="guided-panorama-review__sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="guided-point-editor-title"
          >
            <span className="guided-panorama-review__sheet-handle" aria-hidden="true" />
            <header className="guided-panorama-review__sheet-header">
              <div>
                <p>{editingId ? 'Memory point' : 'New point'}</p>
                <h2 id="guided-point-editor-title">
                  {editorStep === 'choose'
                    ? 'What would you like to add?'
                    : editorStep === 'message'
                      ? editingId ? 'Edit message' : 'Add a message'
                      : editingId ? 'Edit voice note' : 'Add a voice note'}
                </h2>
              </div>
              <button
                type="button"
                className="guided-panorama-review__cancel"
                onClick={resetEditor}
                aria-label="Cancel editing memory point"
              >
                Cancel
              </button>
            </header>

            {editorStep === 'choose' ? (
              <div className="guided-panorama-review__kind-picker">
                <button type="button" onClick={() => setEditorStep('message')}>
                  <span><ReviewIcon name="message" /></span>
                  <strong>Message</strong>
                  <small>Leave a short note</small>
                </button>
                <button
                  type="button"
                  onClick={() => setEditorStep('voice')}
                  disabled={!voiceSupported}
                >
                  <span><ReviewIcon name="voice" /></span>
                  <strong>Voice</strong>
                  <small>{voiceSupported ? 'Record up to 60 seconds' : 'Unavailable on this device'}</small>
                </button>
              </div>
            ) : null}

            {editorStep === 'message' ? (
              <div className="guided-panorama-review__editor">
                <label htmlFor="guided-point-message">Message</label>
                <textarea
                  id="guided-point-message"
                  autoFocus
                  maxLength={MAX_MESSAGE_LENGTH}
                  value={message}
                  placeholder="What makes this part special?"
                  onChange={(event) => setMessage(event.target.value)}
                />
                <div className="guided-panorama-review__editor-meta">
                  <span>Visible when this point is opened</span>
                  <span aria-live="polite">{message.length}/{MAX_MESSAGE_LENGTH}</span>
                </div>
                <button
                  className="guided-panorama-review__save"
                  type="button"
                  disabled={!message.trim()}
                  onClick={() => saveAnnotation('text')}
                >
                  Save message
                </button>
              </div>
            ) : null}

            {editorStep === 'voice' ? (
              <div className="guided-panorama-review__editor guided-panorama-review__voice-editor">
                <label htmlFor="guided-point-voice-description">
                  Voice note description
                </label>
                <textarea
                  id="guided-point-voice-description"
                  autoFocus
                  maxLength={MAX_MESSAGE_LENGTH}
                  value={message}
                  placeholder="What will your family hear in this recording?"
                  aria-describedby="guided-point-voice-description-help"
                  onChange={(event) => setMessage(event.target.value)}
                />
                <div
                  id="guided-point-voice-description-help"
                  className="guided-panorama-review__editor-meta"
                >
                  <span>Required as an accessible description</span>
                  <span aria-live="polite">{message.length}/{MAX_MESSAGE_LENGTH}</span>
                </div>

                {!voiceSupported ? (
                  <p className="guided-panorama-review__voice-error" role="status">
                    Voice recording is not available on this device. Add a message instead.
                  </p>
                ) : null}

                {recording ? (
                  <div className="guided-panorama-review__recording" role="status">
                    <span aria-hidden="true" />
                    <strong>Recording</strong>
                    <time>{formatDuration(recordingElapsed)} / 1:00</time>
                  </div>
                ) : null}

                {voicePreviewUrl ? (
                  <audio
                    className="guided-panorama-review__audio"
                    controls
                    src={voicePreviewUrl}
                    aria-label={voiceDescription
                      ? `Voice note preview: ${voiceDescription}`
                      : 'Voice note preview'}
                  />
                ) : null}

                {voiceError ? (
                  <p className="guided-panorama-review__voice-error" role="alert">
                    {voiceError}
                  </p>
                ) : null}

                {voiceSupported ? (
                  <button
                    className={`guided-panorama-review__record${recording ? ' is-recording' : ''}`}
                    type="button"
                    disabled={requestingMicrophone}
                    onClick={recording ? stopVoiceRecording : () => void beginVoiceRecording()}
                    aria-label={recording ? 'Stop voice recording' : voiceClip ? 'Record voice note again' : 'Start voice recording'}
                  >
                    <span><ReviewIcon name={recording ? 'stop' : 'voice'} /></span>
                    {requestingMicrophone
                      ? 'Opening microphone…'
                      : recording
                        ? 'Stop recording'
                        : voiceClip
                          ? 'Record again'
                          : 'Record voice note'}
                  </button>
                ) : null}

                <p className="guided-panorama-review__voice-hint">
                  Recording stops automatically after 60 seconds.
                </p>
                <button
                  className="guided-panorama-review__save"
                  type="button"
                  disabled={
                    !voiceClip ||
                    !voiceDescription ||
                    voiceDescription.length > MAX_MESSAGE_LENGTH ||
                    recording ||
                    requestingMicrophone
                  }
                  onClick={() => saveAnnotation('voice')}
                >
                  Save voice note
                </button>
              </div>
            ) : null}

            {editingId ? (
              <button
                className="guided-panorama-review__delete"
                type="button"
                onClick={deleteAnnotation}
              >
                Delete point
              </button>
            ) : null}
          </section>
        </div>
      ) : null}
    </section>
  )
}
