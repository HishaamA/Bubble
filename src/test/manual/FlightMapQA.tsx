/** Isolated flight-map fixture: synthetic data only; no account or provider calls. */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FlightTicket } from '../../features/flights/FlightTicket'
import type { TrackedFlight } from '../../features/flights/types'
import '../../index.css'
import '../../App.css'
import '../../features/journal/JournalPage.css'
import '../../features/flights/FlightTrackerSection.css'
import '../../theme/AppTheme.css'

const now = new Date('2026-09-14T08:00:00.000Z')
const flight: TrackedFlight = {
  id: 'qa-flight-jfk-dxb', travelerName: 'Test traveler', flightNumber: 'EK202',
  travelDate: '2026-09-13', createdAt: '2026-09-13T12:00:00.000Z',
  notificationEnabled: false, synced: true,
  snapshot: {
    provider: 'aerodatabox', providerFlightId: null, flightNumber: 'EK202',
    status: 'En route', dataQuality: 'estimated',
    origin: { code: 'JFK', name: 'John F. Kennedy International', city: 'New York',
      timeZone: 'America/New_York', latitude: 40.6413, longitude: -73.7781 },
    destination: { code: 'DXB', name: 'Dubai International', city: 'Dubai',
      timeZone: 'Asia/Dubai', latitude: 25.2532, longitude: 55.3657 },
    scheduledDeparture: '2026-09-14T03:24:00.000Z', estimatedDeparture: null,
    actualDeparture: '2026-09-14T03:24:00.000Z',
    scheduledArrival: '2026-09-14T15:30:00.000Z', estimatedArrival: '2026-09-14T15:30:00.000Z',
    actualArrival: null, progressPercent: null, position: null,
    updatedAt: '2026-09-14T07:48:00.000Z',
  },
}
const idle = { notificationPendingId: null, refreshingId: null, deletingId: null }
const noop = async () => undefined
document.documentElement.dataset.bubbleTheme = 'plum'

export function FlightMapQA() {
  const [theme, setTheme] = useState('plum')
  const [expanded, setExpanded] = useState(true)
  useEffect(() => { document.documentElement.dataset.bubbleTheme = theme }, [theme])
  return <main style={{ width: 'min(100%, 390px)', height: '100dvh', overflowY: 'auto',
    overflowX: 'hidden', margin: '0 auto', background: 'var(--theme-canvas-deep)', padding: '12px' }}>
    <aside aria-label="Flight map test controls" style={{ display: 'flex', flexWrap: 'wrap', gap: 8,
      paddingBottom: 12, color: 'var(--theme-on-canvas)', font: '12px/1.4 system-ui' }}>
      <strong style={{ width: '100%' }}>Synthetic JFK → DXB · mobile fixture</strong>
      {['plum', 'forest', 'midnight'].map((value) => <button key={value} type="button"
        aria-pressed={theme === value} onClick={() => setTheme(value)}
        style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid currentColor',
          background: theme === value ? 'var(--theme-paper)' : 'transparent',
          color: theme === value ? 'var(--theme-ink)' : 'var(--theme-on-canvas)' }}>{value}</button>)}
    </aside>
    <section className="journal-page" data-section="flights" style={{ padding: 0, minHeight: 0 }}>
      <div className="flight-tracker">
        <FlightTicket flight={flight} now={now} expanded={expanded} confirmingDelete={false} activity={idle}
          actions={{ toggleNotifications: noop, refreshFlight: noop, stopTracking: noop,
            openDeleteConfirmation: () => undefined, keepFlight: () => undefined,
            toggleFlightActions: () => setExpanded((value) => !value) }} />
      </div>
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<FlightMapQA />)
