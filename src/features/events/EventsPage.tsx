import '../FeaturePages.css'
import { JournalEventsSection } from './JournalEventsSection'

/**
 * Legacy route wrapper. Family plans now live in Journal; keeping this export
 * avoids breaking older deep links while the router redirects them.
 */
export function EventsPage() {
  return (
    <section
      className="ks-feature events-page"
      aria-labelledby="family-plans-title"
    >
      <header className="ks-feature__header">
        <div className="ks-feature__header-copy">
          <h1 id="family-plans-title">Family plans</h1>
        </div>
      </header>
      <JournalEventsSection />
    </section>
  )
}
