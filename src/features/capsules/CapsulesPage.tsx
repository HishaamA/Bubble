import { useMemo, useState, type FormEvent } from 'react'
import '../FeaturePages.css'

type CapsuleFilter = 'all' | 'mine' | 'locked'

type Capsule = {
  id: string
  title: string
  recipient: string
  owner: 'You' | 'Mum' | 'Hishaam'
  opens: string
  locked: boolean
  contents: string
}

const starterCapsules: Capsule[] = [
  {
    id: 'first-home',
    title: 'For your first home',
    recipient: 'Sara',
    owner: 'You',
    opens: '12 Mar 2027',
    locked: true,
    contents: '4 memories · 1 voice note',
  },
  {
    id: 'summer-letters',
    title: 'Letters from this summer',
    recipient: 'The family',
    owner: 'Mum',
    opens: '1 Sep 2026',
    locked: true,
    contents: '7 notes · 12 photos',
  },
  {
    id: 'grandad-recipes',
    title: 'Grandad’s recipe box',
    recipient: 'Everyone',
    owner: 'Hishaam',
    opens: 'Opened 14 Aug',
    locked: false,
    contents: '9 recipes · 3 stories',
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
  const [filter, setFilter] = useState<CapsuleFilter>('all')
  const [capsules, setCapsules] = useState(starterCapsules)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [recipient, setRecipient] = useState('Sara')
  const [openDate, setOpenDate] = useState('2027-01-01')
  const [announcement, setAnnouncement] = useState('')

  const visibleCapsules = useMemo(() => capsules.filter((capsule) => {
    if (filter === 'mine') return capsule.owner === 'You'
    if (filter === 'locked') return capsule.locked
    return true
  }), [capsules, filter])

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
      contents: 'Empty draft',
    }, ...current])
    setFilter('all')
    setCreating(false)
    setTitle('')
    setAnnouncement(`Created a local preview of ${cleanTitle}.`)
  }

  return (
    <section className="ks-feature capsules-page" aria-labelledby="capsules-title">
      <header className="ks-feature__header">
        <div className="ks-feature__header-copy">
          <p className="eyebrow">Keep for later</p>
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
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
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
                <option>The family</option>
              </select>
            </label>
            <label className="ks-field">
              <span>Open on</span>
              <input type="date" value={openDate} onChange={(event) => setOpenDate(event.target.value)} />
            </label>
          </div>
          <div className="capsule-create__preview" aria-label="Capsule preview">
            <span aria-hidden="true"><CapsuleLock locked /></span>
            <span>
              <strong>{title || 'Untitled capsule'}</strong>
              <small>For {recipient} · opens {openDate || 'later'}</small>
            </span>
          </div>
          <button className="ks-primary-button" type="submit" disabled={!title.trim()}>
            Save local preview
          </button>
          <p className="ks-inline-note">This prototype saves the card only until the page reloads.</p>
        </form>
      ) : (
        <div className="ks-filter-row" aria-label="Filter capsules">
          {(['all', 'mine', 'locked'] as const).map((value) => (
            <button
              key={value}
              className="ks-filter"
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? 'All capsules' : value === 'mine' ? 'Created by me' : 'Still locked'}
            </button>
          ))}
        </div>
      )}

      <section className="ks-section" aria-labelledby="capsule-list-title">
        <div className="ks-section__heading">
          <h2 id="capsule-list-title">{filter === 'all' ? 'Your time vault' : filter === 'mine' ? 'Created by you' : 'Waiting to open'}</h2>
          <span>{visibleCapsules.length} {visibleCapsules.length === 1 ? 'capsule' : 'capsules'}</span>
        </div>

        <div className="ks-stack">
          {visibleCapsules.length ? visibleCapsules.map((capsule) => (
            <article
              key={capsule.id}
              className="ks-card capsule-card"
            >
              <div className="capsule-card__top">
                <span className="capsule-card__lock"><CapsuleLock locked={capsule.locked} /></span>
                <span className="capsule-card__date">{capsule.locked ? `Opens ${capsule.opens}` : capsule.opens}</span>
              </div>
              <div>
                <h3>{capsule.title}</h3>
                <p>For {capsule.recipient} · by {capsule.owner}</p>
              </div>
              <div className="capsule-card__bottom">
                <span>{capsule.contents}</span>
                <strong>{capsule.locked ? 'Sealed' : 'Ready to revisit'}</strong>
              </div>
            </article>
          )) : <div className="ks-card capsule-empty">No capsules match this filter yet.</div>}
        </div>
      </section>
    </section>
  )
}
