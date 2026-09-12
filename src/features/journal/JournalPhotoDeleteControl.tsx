import { useEffect, useId, useRef, useState } from 'react'
import './JournalPhotoDeleteControl.css'

type JournalPhotoDeleteControlProps = {
  photoId: string
  shared: boolean
  onDelete: (photoId: string) => Promise<void>
}

/** An explicit, inline confirmation for the current user's Journal upload. */
export function JournalPhotoDeleteControl({ photoId, shared, onDelete }: JournalPhotoDeleteControlProps) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const descriptionId = useId()
  const titleId = useId()

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (confirming) cancelButton.current?.focus()
  }, [confirming])

  const cancelConfirmation = () => {
    if (pending.current) return
    setConfirming(false)
    setError('')
    requestAnimationFrame(() => trigger.current?.focus())
  }

  const removePhoto = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await onDelete(photoId)
      if (mounted.current) setConfirming(false)
    } catch {
      if (mounted.current) setError('The photo wasn’t deleted. Check your connection and try again.')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <section className={`journal-photo-delete journal-photo-delete--compact${confirming ? ' journal-photo-delete--confirming' : ''}`} aria-label="Manage your photo">
      {confirming ? (
        <div className="journal-photo-delete__confirmation" role="group"
          aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy}>
          <h3 id={titleId}>Delete this photo?</h3>
          <p id={descriptionId}>
            {shared
              ? 'This removes your upload from the shared Journal for everyone in your family.'
              : 'This removes your upload from this Journal.'}
            {' '}Your original phone photo, separate Capsule copies, and saved downloads stay unchanged.
          </p>
          <div className="journal-photo-delete__actions">
            <button ref={cancelButton} type="button" disabled={busy} onClick={cancelConfirmation}>Keep photo</button>
            <button type="button" className="journal-photo-delete__confirm" disabled={busy}
              aria-describedby={descriptionId} onClick={() => { void removePhoto() }}>
              {busy ? 'Deleting…' : 'Delete photo'}
            </button>
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : (
        <button ref={trigger} type="button" className="journal-photo-delete__compact-trigger"
          aria-label="Delete my photo" title="Delete my photo" onClick={() => setConfirming(true)}>
          <span aria-hidden="true">×</span>
        </button>
      )}
    </section>
  )
}
