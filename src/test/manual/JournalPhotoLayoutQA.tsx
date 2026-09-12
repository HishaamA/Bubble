/** Fake photos only; no sign-in, remote requests or production account state. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PeopleTimelineDateEditor } from '../../features/journal/people/PeopleTimelinePhotoDetails'
import { JournalPhotoDeleteControl } from '../../features/journal/JournalPhotoDeleteControl'
import { PersonScrapbookPage } from '../../features/journal/people/PersonScrapbookPage'
import type { PeopleTimelinePhoto, TimelineDateOverride } from '../../features/journal/people/types'
import '../../features/journal/people/PeopleTimeline.css'
import '../../features/journal/JournalPage.css'
import '../../index.css'
import '../../App.css'
import '../../theme/AppTheme.css'
import './FamilyScreenQA.css'

const theme = new URLSearchParams(location.search).get('theme')
document.documentElement.dataset.bubbleTheme =
  theme === 'forest' || theme === 'midnight' ? theme : 'plum'

const photos: PeopleTimelinePhoto[] = [
  [900, 650], [650, 950], [900, 650], [650, 950],
].map(([width, height], index) => {
  const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${['#a5b37a', '#e6b5c4', '#7897d0', '#efb43d'][index]}"/><circle cx="50%" cy="45%" r="120" fill="none" stroke="#fff1d2" stroke-width="20"/><text x="50%" y="72%" font-size="45" font-family="serif" text-anchor="middle" fill="#301027">Test photo ${index + 1}</text></svg>`
  const source = `data:image/svg+xml,${encodeURIComponent(artwork)}`
  return {
    key: `qa-photo-${index}`, id: `qa-photo-${index}`, kind: 'capsule-photo',
    source, scanSource: source, displayWidth: width, displayHeight: height,
    capturedAt: '2026-09-03T12:00:00.000Z',
    caption: index === 2 ? 'Our wonderfully long afternoon together at the family reunion' : `A little family moment ${index + 1}`,
    contributorName: index === 1 ? 'Alexandra-Christina LongFamilyNameWithoutSpaces' : 'Test family',
    capsuleId: 'qa-capsule', memoryId: `qa-memory-${index}`, canScanFaces: false,
  }
})

export function JournalPhotoLayoutQA() {
  const [page, setPage] = useState<'date' | 'scrapbook'>('date')
  const [draft, setDraft] = useState<TimelineDateOverride>({ precision: 'day', value: '2026-09-03' })
  const [status, setStatus] = useState('')
  return <>
    <aside className="qa-controls" aria-label="Journal photo layout test controls">
      <strong>Isolated test · {document.documentElement.dataset.bubbleTheme}</strong>
      <button type="button" onClick={() => setPage('date')}>Date editor</button>
      <button type="button" onClick={() => setPage('scrapbook')}>Scrapbook</button>
      <span role="status">{status}</span>
    </aside>
    <div className="app-viewport app-viewport--native qa-viewport" data-app-shell="native">
      <main className="app-content">
        <section className="journal-page" aria-label="Journal layout test">
          {page === 'date' ? <div className="people-timeline">
            <h1>Edit photo date</h1>
            <PeopleTimelineDateEditor
              draft={draft} error="" hasOverride
              onValueChange={(value) => setDraft({ ...draft, value })}
              onPrecisionChange={(precision) => setDraft({ precision, value: precision === 'year' ? '2026' : '2026-09-03' })}
              onSave={(event) => { event.preventDefault(); setStatus(`Saved ${draft.value}`) }}
              onCancel={() => setStatus('Cancelled')}
              onRestoreOriginal={() => setDraft({ precision: 'day', value: '2026-09-03' })}
            />
            <JournalPhotoDeleteControl photoId="qa-fake-photo" shared onDelete={() => {
              setStatus('Simulated deletion · no real photo')
              return Promise.resolve()
            }} />
          </div> : <PersonScrapbookPage
            person={{ id: 'qa-person', name: 'Test family member', createdAt: '2026-01-01T00:00:00.000Z' }}
            photos={photos} cacheNamespace="qa-journal-photo-layout:no-account"
          />}
        </section>
      </main>
    </div>
  </>
}

createRoot(document.getElementById('root')!).render(<JournalPhotoLayoutQA />)
