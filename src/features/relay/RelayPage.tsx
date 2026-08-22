import { useState, type FormEvent } from 'react'
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
  const sharedNames = submitted
    ? 'You, Mum, Hishaam and Sara have shared'
    : 'Mum, Hishaam and Sara have shared'

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
      <header className="ks-feature__header app-page-header">
        <div className="ks-feature__header-copy">
          <p className="eyebrow app-page-header__eyebrow">Our family</p>
          <h1 id="relay-title">Family Relay</h1>
        </div>
      </header>

      <article className="ks-card ks-card--accent relay-hero" aria-labelledby="relay-prompt">
        <div className="relay-hero__meta">
          <div className="ks-avatar-stack" aria-label={sharedNames}>
            <span className="ks-avatar" aria-hidden="true">SA</span>
            <span className="ks-avatar" aria-hidden="true">HM</span>
            <span className="ks-avatar" aria-hidden="true">RA</span>
            {submitted ? <span className="ks-avatar" aria-hidden="true">YOU</span> : null}
          </div>
          <span className="relay-hero__time" aria-live="polite">{sharedNames}</span>
        </div>
        <h2 id="relay-prompt">Show us your view right now.</h2>
        <p>At 8:00 PM, everyone’s moments appear together.</p>
      </article>

      <section className="ks-section" aria-labelledby="contribute-title">
        <div className="ks-section__heading">
          <h2 id="contribute-title">Your turn</h2>
        </div>

        {submitted ? (
          <div className="ks-card relay-success" role="status">
            <div>
              <span className="relay-success__check" aria-hidden="true">✓</span>
              <h3>You’re part of today</h3>
              <p>Your moment will meet the family’s at 8:00 PM.</p>
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
                <span>{hasPhoto ? 'Moment selected' : 'Choose a moment'}</span>
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
              {mode === 'note' ? <p className="ks-inline-note">{note.length}/120</p> : null}
              <button className="ks-primary-button" type="submit" disabled={!canSend}>
                Share with family
              </button>
            </div>
          </form>
        )}
      </section>
    </section>
  )
}
