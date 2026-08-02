import { useState, type FormEvent } from 'react'
import '../FeaturePages.css'

type GuestbookEntry = {
  id: string
  initials: string
  name: string
  message: string
}
const upcomingEvents = [
  { day: '18', month: 'Sep', title: 'Beach breakfast', detail: '7:30 AM · Kite Beach' },
  { day: '02', month: 'Oct', title: 'Sara’s graduation', detail: '6:00 PM · Family room' },
  { day: '21', month: 'Nov', title: 'Grandad’s story night', detail: '8:00 PM · Video call' },
]

export function EventsPage() {
  const [isGoing, setIsGoing] = useState(false)
  const [message, setMessage] = useState('')
  const [entries, setEntries] = useState<GuestbookEntry[]>([
    { id: 'mum', initials: 'MA', name: 'Mum', message: 'I’m bringing the saffron cake. Can’t wait to have everyone together.' },
  ])

  function addGuestbookEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanMessage = message.trim()
    if (!cleanMessage) return

    setEntries((current) => [
      ...current,
      { id: `local-${current.length + 1}`, initials: 'YOU', name: 'You', message: cleanMessage },
    ])
    setMessage('')
  }

  return (
    <section className="ks-feature events-page" aria-labelledby="events-title">
      <header className="ks-feature__header">
        <div className="ks-feature__header-copy">
          <p className="eyebrow">Together soon</p>
          <h1 id="events-title">Events</h1>
        </div>
        <span className="ks-local-badge">Demo</span>
      </header>

      <article className="ks-card event-hero" aria-labelledby="featured-event-title">
        <div className="event-hero__top">
          <div className="event-hero__date" aria-label="September 6">
            <strong>06</strong>
            <span>Sep</span>
          </div>
          <span className="event-hero__countdown">11 days to go</span>
        </div>
        <div className="event-hero__body">
          <h2 id="featured-event-title">Family dinner</h2>
          <p>Saturday · 7:00 PM · The courtyard</p>
          <div className="event-hero__footer">
            <div className="ks-avatar-stack" aria-label="Mum, Hishaam, and four more are attending">
              <span className="ks-avatar" aria-hidden="true">MA</span>
              <span className="ks-avatar" aria-hidden="true">HM</span>
              <span className="ks-avatar" aria-hidden="true">SA</span>
              <span className="ks-avatar" aria-hidden="true">+4</span>
            </div>
            <button
              className="event-rsvp"
              type="button"
              aria-pressed={isGoing}
              onClick={() => setIsGoing((value) => !value)}
            >
              {isGoing ? '✓ Going' : 'I’m going'}
            </button>
          </div>
        </div>
      </article>

      <section className="ks-section" aria-labelledby="upcoming-events-title">
        <div className="ks-section__heading">
          <h2 id="upcoming-events-title">Coming up</h2>
          <span>{upcomingEvents.length} plans</span>
        </div>
        <div className="event-list">
          {upcomingEvents.map((event) => (
            <article key={`${event.day}-${event.month}`} className="ks-card event-list-item">
              <div className="event-list-item__date" aria-label={`${event.month} ${event.day}`}>
                <strong>{event.day}</strong>
                <span>{event.month}</span>
              </div>
              <div>
                <h3>{event.title}</h3>
                <p>{event.detail}</p>
              </div>
              <span className="event-list-item__arrow" aria-hidden="true">›</span>
            </article>
          ))}
        </div>
      </section>

      <section className="ks-section" aria-labelledby="guestbook-title">
        <div className="ks-section__heading">
          <h2 id="guestbook-title">Dinner guestbook</h2>
          <span aria-live="polite">{entries.length} {entries.length === 1 ? 'note' : 'notes'}</span>
        </div>
        <div className="ks-card guestbook-card">
          {entries.map((entry) => (
            <article key={entry.id} className="guestbook-entry">
              <span className="guestbook-entry__avatar" aria-hidden="true">{entry.initials}</span>
              <div>
                <strong>{entry.name}</strong>
                <p>{entry.message}</p>
              </div>
            </article>
          ))}
          <form className="guestbook-form" onSubmit={addGuestbookEntry}>
            <label className="screen-reader-only" htmlFor="guestbook-message">Add a note to the dinner guestbook</label>
            <input
              id="guestbook-message"
              value={message}
              maxLength={100}
              placeholder="Leave a note for everyone…"
              onChange={(event) => setMessage(event.target.value)}
            />
            <button type="submit" disabled={!message.trim()} aria-label="Add guestbook note">↑</button>
          </form>
          <p className="ks-inline-note">Notes added here are local to this prototype.</p>
        </div>
      </section>
    </section>
  )
}
