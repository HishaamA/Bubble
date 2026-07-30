import { useState } from 'react'
import '../FeaturePages.css'
import { FamilySyncPanel } from './family-sync'

type ToggleRowProps = {
  id: string
  label: string
  description: string
  checked: boolean
  onChange: () => void
}

function ToggleRow({ id, label, description, checked, onChange }: ToggleRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row__copy">
        <strong id={`${id}-label`}>{label}</strong>
        <span id={`${id}-description`}>{description}</span>
      </div>
      <button
        className="ks-toggle"
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        onClick={onChange}
      >
        <span className="screen-reader-only">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>
  )
}

export function ProfilePage() {
  const [notifications, setNotifications] = useState(true)
  const [quietHours, setQuietHours] = useState(true)
  const [lowData, setLowData] = useState(false)
  const [status, setStatus] = useState('')

  function showDemoStatus(message: string) {
    setStatus(message)
  }

  return (
    <section className="ks-feature profile-page" aria-labelledby="profile-title">
      <header className="ks-feature__header">
        <div className="ks-feature__header-copy">
          <p className="eyebrow">Your space</p>
          <h1 id="profile-title">Profile</h1>
        </div>
        <span className="ks-local-badge">MVP</span>
      </header>

      <article className="ks-card ks-card--accent profile-card">
        <div className="profile-card__avatar" aria-hidden="true">S</div>
        <div>
          <h2>Simreen</h2>
          <p>Your local KinSphere profile</p>
        </div>
      </article>

      <FamilySyncPanel />

      <section className="ks-section" aria-labelledby="preferences-title">
        <div className="ks-section__heading">
          <h2 id="preferences-title">Preferences</h2>
          <span>Saved locally</span>
        </div>
        <div className="ks-card settings-card">
          <ToggleRow
            id="family-notifications"
            label="Family notifications"
            description="Relay prompts, capsule openings, and event updates"
            checked={notifications}
            onChange={() => setNotifications((value) => !value)}
          />
          <ToggleRow
            id="quiet-hours"
            label="Quiet hours"
            description="Silence non-urgent updates from 10 PM to 8 AM"
            checked={quietHours}
            onChange={() => setQuietHours((value) => !value)}
          />
          <ToggleRow
            id="low-data-mode"
            label="Low-Data Mode"
            description="Preview lower-resolution panoramas on mobile data"
            checked={lowData}
            onChange={() => setLowData((value) => !value)}
          />
        </div>
      </section>

      <section className="ks-section" aria-labelledby="profile-more-title">
        <div className="ks-section__heading">
          <h2 id="profile-more-title">More</h2>
        </div>
        <div className="ks-stack">
          <button className="profile-action-row" type="button" onClick={() => showDemoStatus('Privacy controls are represented here as a UI preview only.')}>
            <span>Data &amp; privacy</span><span aria-hidden="true">›</span>
          </button>
          <button className="profile-action-row" type="button" onClick={() => showDemoStatus('Help content will be added after the core family flows are tested.')}>
            <span>Help &amp; feedback</span><span aria-hidden="true">›</span>
          </button>
        </div>
      </section>

      {status ? (
        <button className="profile-toast" type="button" aria-live="polite" onClick={() => setStatus('')}>
          {status} Tap to dismiss.
        </button>
      ) : null}
    </section>
  )
}
