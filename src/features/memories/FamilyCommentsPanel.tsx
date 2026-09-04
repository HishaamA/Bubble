import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { PanoramaAnnotation } from './shared'
import './FamilyCommentsPanel.css'

const MAX_COMMENT_LENGTH = 500

export type FamilyCommentView = {
  id: string
  annotationId: string | null
  authorDisplayName: string
  body: string
  createdAt: string
  synced: boolean
}

type FamilyCommentsPanelProps = {
  open: boolean
  comments: readonly FamilyCommentView[]
  annotations: readonly PanoramaAnnotation[]
  targetAnnotationId: string | null
  loading?: boolean
  sending?: boolean
  error?: string | null
  onClose: () => void
  onTargetChange: (annotationId: string | null) => void
  onSubmit: (body: string, annotationId: string | null) => void | Promise<void>
}

/** Draws the comments glyph without introducing a separate icon dependency. */
function CommentsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 5.5h13a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3v-3h-1A2.5 2.5 0 0 1 3 15V8a2.5 2.5 0 0 1 2.5-2.5Z" />
      <path d="M7.5 10h9M7.5 13h6" />
    </svg>
  )
}

/** Gives point replies stable, human-readable labels even without authored text. */
function annotationLabel(annotation: PanoramaAnnotation, index: number) {
  const message = annotation.message.trim()
  if (!message) {
    return annotation.kind === 'voice'
      ? `Voice note ${index + 1}`
      : `Memory point ${index + 1}`
  }
  const shortened = message.length > 30 ? `${message.slice(0, 29)}…` : message
  return annotation.kind === 'voice' ? `Voice: ${shortened}` : shortened
}

/** Formats valid timestamps and avoids exposing invalid-date output in the panel. */
function formatCommentTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

/**
 * Presents the modal family conversation for a panorama or one memory point.
 * Submission ownership remains with the parent so local and synced transports
 * share the same accessible composer.
 */
export function FamilyCommentsPanel({
  open,
  comments,
  annotations,
  targetAnnotationId,
  loading = false,
  sending = false,
  error,
  onClose,
  onTargetChange,
  onSubmit,
}: FamilyCommentsPanelProps) {
  const [body, setBody] = useState('')
  const panelRef = useRef<HTMLElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const submitPendingRef = useRef(false)

  const annotationLabels = useMemo(
    () => new Map(
      annotations.map((annotation, index) => [
        annotation.id,
        annotationLabel(annotation, index),
      ]),
    ),
    [annotations],
  )
  const selectedLabel = targetAnnotationId
    ? annotationLabels.get(targetAnnotationId) ?? 'Memory point'
    : 'This whole moment'

  useEffect(() => {
    if (!open) return
    // Moving between a whole-moment comment and a point reply deliberately
    // returns the keyboard to the composer instead of forcing another tap.
    const frame = window.requestAnimationFrame(() => {
      composerRef.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, targetAnnotationId])

  if (!open) return null

  /** Traps Tab focus inside the modal comments sheet. */
  const keepFocusInside = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    // The panorama remains mounted behind this sheet, so a manual focus loop
    // prevents Tab from activating viewer controls through the modal layer.
    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea:not(:disabled)',
      ) ?? [],
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  /** Validates and synchronously latches one comment submission. */
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cleanBody = body.trim()
    // `sending` arrives from the parent on the next render. The ref also locks
    // the handler synchronously, which protects against a rapid Enter + tap.
    if (!cleanBody || sending || submitPendingRef.current) return
    submitPendingRef.current = true
    void Promise.resolve(onSubmit(cleanBody, targetAnnotationId))
      .then(() => setBody(''))
      .catch(() => undefined)
      .finally(() => {
        submitPendingRef.current = false
      })
  }

  return (
    <div className="family-comments-layer">
      <button
        className="family-comments-layer__backdrop"
        type="button"
        aria-label="Close family comments"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        id="family-comments-panel"
        className="family-comments-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="family-comments-title"
        onKeyDown={keepFocusInside}
      >
        <header className="family-comments-panel__header">
          <span className="family-comments-panel__icon"><CommentsIcon /></span>
          <div>
            <h2 id="family-comments-title">Family comments</h2>
            <p>{comments.length} {comments.length === 1 ? 'thought' : 'thoughts'} together</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close comments">×</button>
        </header>

        <div className="family-comments-panel__scopes" aria-label="Comment on">
          <button
            type="button"
            className={targetAnnotationId === null ? 'is-active' : undefined}
            aria-pressed={targetAnnotationId === null}
            onClick={() => onTargetChange(null)}
          >
            Whole moment
          </button>
          {annotations.map((annotation, index) => (
            <button
              key={annotation.id}
              type="button"
              className={targetAnnotationId === annotation.id ? 'is-active' : undefined}
              aria-pressed={targetAnnotationId === annotation.id}
              onClick={() => onTargetChange(annotation.id)}
            >
              {annotationLabel(annotation, index)}
            </button>
          ))}
        </div>

        <section className="family-comments-panel__list" aria-label="Family conversation">
          {loading ? <p className="family-comments-panel__empty" role="status">Bringing in everyone’s thoughts…</p> : null}
          {!loading && comments.length === 0 ? (
            <div className="family-comments-panel__empty">
              <span aria-hidden="true">♡</span>
              <p>No comments yet. Leave the first little note for your family.</p>
            </div>
          ) : null}
          {comments.map((comment) => (
            <article key={comment.id} className="family-comment">
              <header>
                <strong>{comment.authorDisplayName}</strong>
                <time dateTime={comment.createdAt}>{formatCommentTime(comment.createdAt)}</time>
              </header>
              {comment.annotationId ? (
                <span className="family-comment__context">
                  Reply to {annotationLabels.get(comment.annotationId) ?? 'memory point'}
                </span>
              ) : null}
              <p>{comment.body}</p>
              {!comment.synced ? <small>On this device</small> : null}
            </article>
          ))}
        </section>

        <form className="family-comments-panel__composer" onSubmit={submit}>
          <label htmlFor="family-comment-body">Comment on <strong>{selectedLabel}</strong></label>
          <div>
            <textarea
              ref={composerRef}
              id="family-comment-body"
              value={body}
              rows={2}
              maxLength={MAX_COMMENT_LENGTH}
              placeholder="Add a thought for the family…"
              onChange={(event) => setBody(event.target.value)}
            />
            <button type="submit" disabled={!body.trim() || sending}>
              {sending ? 'Sending…' : 'Post'}
            </button>
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </form>
      </aside>
    </div>
  )
}
