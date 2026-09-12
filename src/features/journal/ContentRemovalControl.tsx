import { useEffect, useId, useRef, useState } from 'react'
import './JournalPhotoDeleteControl.css'

type Props = {
  noun: 'photo' | 'Capsule'
  hideOnly?: boolean
  compact?: boolean
  description: string
  onRemove: () => Promise<void>
}

/** One explicit, accessible confirmation for shared deletions and reversible personal hiding. */
export function ContentRemovalControl({ noun, hideOnly = false, compact = false, description, onRemove }: Props) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const cancel = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const verb = hideOnly ? 'Hide' : 'Delete'
  const triggerLabel = `${verb} ${noun}${hideOnly ? ' for me' : ''}`
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (confirming) cancel.current?.focus() }, [confirming])
  async function remove() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await onRemove()
      if (mounted.current) setConfirming(false)
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Could not remove this item. Please try again.')
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return <section className={`journal-photo-delete${compact ? ' journal-photo-delete--compact' : ''}${confirming ? ' journal-photo-delete--confirming' : ''}`} aria-label={`Manage ${noun}`}>
    {confirming ? <div className="journal-photo-delete__confirmation" role="group" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-busy={busy}>
      <h3 id={`${id}-title`}>{verb} this {noun}?</h3>
      <p id={`${id}-description`}>{description}</p>
      <div className="journal-photo-delete__actions">
        <button ref={cancel} type="button" disabled={busy} onClick={() => {
          if (inFlight.current) return
          setConfirming(false); setError(''); requestAnimationFrame(() => trigger.current?.focus())
        }}>Keep {noun}</button>
        <button type="button" className="journal-photo-delete__confirm" disabled={busy} onClick={() => { void remove() }}>
          {busy ? 'Removing…' : `${verb} ${noun}`}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div> : <button ref={trigger} type="button"
      className={compact ? 'journal-photo-delete__compact-trigger' : undefined}
      aria-label={compact ? triggerLabel : undefined} title={compact ? triggerLabel : undefined}
      onClick={() => setConfirming(true)}>
      {compact ? <span aria-hidden="true">×</span> : triggerLabel}
    </button>}
  </section>
}
