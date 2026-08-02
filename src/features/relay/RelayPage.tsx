import { useState, type CSSProperties, type FormEvent } from 'react'
import '../FeaturePages.css'

type ComposerMode = 'photo' | 'note'

function PlusIcon() {
  return (
    <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function RelayPage() {
  const [mode, setMode] = useState<ComposerMode>('photo')
  const [note, setNote] = useState('')
  const [hasPhoto, setHasPhoto] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const canSend = mode === 'photo' ? hasPhoto : note.trim().length > 0
  const sharedCount = submitted ? 4 : 3

  function submitContribution(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSend) return
    setSubmitted(true)
  }

  function resetComposer() {
    setSubmitted(false)
    setHasPhoto(false)
    setNote('')
  }

  return (
    <section className="ks-feature relay-page" aria-labelledby="relay-title">
      <header className="ks-feature__header">
        <div className="ks-feature__header-copy">
          <p className="eyebrow">Day Relay</p>
          <h1 id="relay-title">Today</h1>
        </div>
        <span className="ks-local-badge">Demo</span>
      </header>

      <article className="ks-card ks-card--accent relay-hero" aria-labelledby="relay-prompt">
        <div className="relay-hero__meta">
          <div className="ks-avatar-stack" aria-label={`${sharedCount} of 6 family members have shared`}>
            <span className="ks-avatar" aria-hidden="true">SA</span>
            <span className="ks-avatar" aria-hidden="true">HM</span>
            <span className="ks-avatar" aria-hidden="true">RA</span>
            {submitted ? <span className="ks-avatar" aria-hidden="true">YOU</span> : null}
          </div>
          <span className="relay-hero__time">Reveals at 8:00 PM</span>
        </div>
        <h2 id="relay-prompt">Show us your view right now.</h2>
        <p>One small window into everyone’s day, gathered into a private family mosaic.</p>
        <div className="relay-hero__progress">
          <div className="relay-hero__progress-row">
            <strong aria-live="polite">{sharedCount} of 6 shared</strong>
            <span className="ks-local-badge">Private</span>
          </div>
          <div className="ks-progress" aria-hidden="true">
            <span style={{ '--progress': `${(sharedCount / 6) * 100}%` } as CSSProperties} />
          </div>
        </div>
      </article>

      <section className="ks-section" aria-labelledby="contribute-title">
        <div className="ks-section__heading">
          <h2 id="contribute-title">Your turn</h2>
          <span>Local preview</span>
        </div>

        {submitted ? (
          <div className="ks-card relay-success" role="status">
            <div>
              <span className="relay-success__check" aria-hidden="true">✓</span>
              <h3>Added to today’s relay</h3>
              <p>Your demo contribution is ready for the 8:00 PM reveal.</p>
              <button className="ks-secondary-button" type="button" onClick={resetComposer}>
                Change contribution
              </button>
            </div>
          </div>
        ) : (
          <form className="ks-card relay-composer" onSubmit={submitContribution}>
            <div className="relay-composer__modes" aria-label="Contribution type">
              <button type="button" aria-pressed={mode === 'photo'} onClick={() => setMode('photo')}>
                Photo moment
              </button>
              <button type="button" aria-pressed={mode === 'note'} onClick={() => setMode('note')}>
                Tiny note
              </button>
            </div>

            {mode === 'photo' ? (
              <button
                className="relay-composer__photo"
                type="button"
                aria-pressed={hasPhoto}
                onClick={() => setHasPhoto((value) => !value)}
              >
                <span aria-hidden="true">{hasPhoto ? '✓' : <PlusIcon />}</span>
                <span>{hasPhoto ? 'A demo photo is selected' : 'Choose a moment from this device'}</span>
              </button>
            ) : (
              <label className="ks-field">
                <span>Note for the family</span>
                <textarea
                  value={note}
                  maxLength={120}
                  placeholder="The sunset made me think of all of you…"
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
            )}

            <div className="relay-composer__actions">
              <p className="ks-inline-note">
                {mode === 'note' ? `${note.length}/120 characters` : 'Nothing leaves this prototype.'}
              </p>
              <button className="ks-primary-button" type="submit" disabled={!canSend}>
                Add to relay
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="ks-section" aria-labelledby="relay-rhythm-title">
        <div className="ks-section__heading">
          <h2 id="relay-rhythm-title">Today’s rhythm</h2>
          <span>Gulf Standard Time</span>
        </div>
        <div className="relay-mini-list">
          <article className="ks-card relay-mini-item">
            <span className="relay-mini-item__icon" aria-hidden="true">☀</span>
            <div><strong>Prompt opened</strong><span>9:00 AM · Everyone notified quietly</span></div>
          </article>
          <article className="ks-card relay-mini-item">
            <span className="relay-mini-item__icon" aria-hidden="true">✦</span>
            <div><strong>Family reveal</strong><span>8:00 PM · Contributions appear together</span></div>
          </article>
        </div>
      </section>
    </section>
  )
}
