import type { FormEventHandler, Ref } from 'react'
import { CaptureIcon } from './CaptureIcon'

type CaptureDraftEditorProps = {
  previewUrl: string
  warning?: string
  annotationCount: number
  caption: string
  sharing: boolean
  error: string
  connectedFamilySync: boolean
  captionInputRef: Ref<HTMLTextAreaElement>
  onCaptionChange: (caption: string) => void
  onSubmit: FormEventHandler<HTMLFormElement>
  onRemove: () => void
  onReview: () => void
}

/** Controlled draft form; the capture controller owns media, saves and sharing. */
export function CaptureDraftEditor({
  previewUrl, warning, annotationCount, caption, sharing, error,
  connectedFamilySync, captionInputRef, onCaptionChange, onSubmit, onRemove, onReview,
}: CaptureDraftEditorProps) {
  return (
    <form className="capture-editor" onSubmit={onSubmit}>
      <div className="capture-preview">
        <img src={previewUrl} alt="Preview of selected 360 panorama" />
        <button
          type="button"
          aria-label="Remove selected panorama"
          disabled={sharing}
          onClick={onRemove}
        >
          <CaptureIcon name="close" />
        </button>
      </div>

      {warning ? <p className="capture-quality-note">{warning}</p> : null}

      {annotationCount > 0 ? (
        <p className="capture-quality-note">
          {annotationCount} memory {annotationCount === 1 ? 'point' : 'points'} will appear inside this 360° moment.
        </p>
      ) : null}

      <button
        className="ks-secondary-button capture-editor__review-button"
        type="button"
        disabled={sharing}
        onClick={onReview}
      >
        Edit 360 &amp; points
      </button>

      <div className="capture-editor__composer">
        <label className="ks-field">
          <span>Moment title <small>optional · above the bubble</small></span>
          <textarea
            ref={captionInputRef}
            value={caption}
            rows={3}
            maxLength={160}
            enterKeyHint="done"
            autoCapitalize="sentences"
            placeholder="Dinner together on the balcony…"
            disabled={sharing}
            onChange={(event) => onCaptionChange(event.target.value)}
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
      </div>
    </form>
  )
}
