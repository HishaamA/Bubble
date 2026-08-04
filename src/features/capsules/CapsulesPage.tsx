import { useState, type FormEvent } from 'react'
import '../FeaturePages.css'

type Capsule = {
  id: string
  title: string
  recipient: string
  owner: 'You' | 'Mum' | 'Hishaam'
  opens: string
  locked: boolean
}

const starterCapsules: Capsule[] = [
  {
    id: 'first-home',
    title: 'For your first home',
    recipient: 'Sara',
    owner: 'You',
    opens: '12 Mar 2027',
    locked: true,
  },
  {
    id: 'summer-letters',
    title: 'Letters from this summer',
    recipient: 'the family',
    owner: 'Mum',
    opens: '1 Sep 2026',
    locked: true,
  },
  {
    id: 'grandad-recipes',
    title: 'Grandad’s recipe box',
    recipient: 'everyone',
    owner: 'Hishaam',
    opens: 'Opened 14 Aug',
    locked: false,
  },
]

function CapsuleLock({ locked }: { locked: boolean }) {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="10" width="14" height="10" rx="3" />
      {locked ? <path d="M8 10V7a4 4 0 0 1 8 0v3" /> : <path d="M8 10V7a4 4 0 0 1 7-2.6" />}
    </svg>
  )
}

export function CapsulesPage() {
  const [capsules, setCapsules] = useState(starterCapsules)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [recipient, setRecipient] = useState('Sara')
  const [openDate, setOpenDate] = useState('2027-01-01')
  const [announcement, setAnnouncement] = useState('')

  function createCapsule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanTitle = title.trim()
    if (!cleanTitle) return

    const friendlyDate = new Intl.DateTimeFormat('en', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${openDate}T00:00:00Z`))

    setCapsules((current) => [{
      id: `local-${current.length + 1}`,
      title: cleanTitle,
      recipient,
      owner: 'You',
      opens: friendlyDate,
      locked: true,
    }, ...current])
    setCreating(false)
    setTitle('')
    setAnnouncement(`${cleanTitle} was added to your capsules.`)
  }

  return (
    <section className="ks-feature capsules-page" aria-labelledby="capsules-title">
      <header className="ks-feature__header">
        <div className="ks-feature__header-copy">
          <h1 id="capsules-title">Capsules</h1>
        </div>
        <button
          className="ks-feature__header-action"
          type="button"
          aria-label={creating ? 'Close new capsule form' : 'Create a capsule'}
          aria-expanded={creating}
          onClick={() => setCreating((value) => !value)}
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            {creating ? <path d="m6 6 12 12M18 6 6 18" /> : <path d="M12 5v14M5 12h14" />}
          </svg>
        </button>
      </header>

      <p className="screen-reader-only" aria-live="polite">{announcement}</p>

      {creating ? (
        <form className="ks-card ks-card--accent capsule-create" onSubmit={createCapsule}>
          <div className="capsule-create__heading">
            <h2>New capsule</h2>
            <button type="button" onClick={() => setCreating(false)}>Done</button>
          </div>
          <label className="ks-field">
            <span>Capsule name</span>
            <input
              autoFocus
              value={title}
              maxLength={48}
              placeholder="A message for graduation"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="capsule-create__row">
            <label className="ks-field">
              <span>For</span>
              <select value={recipient} onChange={(event) => setRecipient(event.target.value)}>
                <option>Sara</option>
                <option>Hishaam</option>
                <option value="the family">The family</option>
              </select>
            </label>
            <label className="ks-field">
              <span>Open on</span>
              <input type="date" value={openDate} onChange={(event) => setOpenDate(event.target.value)} />
            </label>
          </div>
          <button className="ks-primary-button" type="submit" disabled={!title.trim()}>
            Create capsule
          </button>
        </form>
      ) : null}

      <section className="ks-section" aria-labelledby="capsule-list-title">
        <div className="ks-section__heading">
          <h2 id="capsule-list-title">Saved for later</h2>
        </div>

        <div className="ks-stack">
          {capsules.map((capsule) => (
            <article
              key={capsule.id}
              className="ks-card capsule-card"
            >
              <span className="capsule-card__lock"><CapsuleLock locked={capsule.locked} /></span>
              <div className="capsule-card__copy">
                <h3>{capsule.title}</h3>
                <p>For {capsule.recipient} · from {capsule.owner === 'You' ? 'you' : capsule.owner}</p>
              </div>
              <span className="capsule-card__date">{capsule.locked ? `Opens ${capsule.opens}` : capsule.opens}</span>
            </article>
          ))}
        </div>
      </section>
    </section>
  )
}
