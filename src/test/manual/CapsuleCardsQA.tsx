/** Presentation-only fixtures: no real account, network writes, or family media. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CapsuleCard } from '../../features/capsules/CapsuleCard'
import { CapsulePhotoManager } from '../../features/capsules/CapsulePhotoManager'
import { ContentRemovalControl } from '../../features/journal/ContentRemovalControl'
import type { FamilyCapsule } from '../../features/capsules/types'
import '../../index.css'
import '../../App.css'
import '../../features/FeaturePages.css'
import '../../features/capsules/CapsulesPage.css'
import '../../theme/AppTheme.css'

const theme = new URLSearchParams(location.search).get('theme')
document.documentElement.dataset.bubbleTheme =
  theme === 'forest' || theme === 'midnight' ? theme : 'plum'
const now = new Date('2026-09-12T12:00:00.000Z')
const artwork = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#a5b37a"/><circle cx="300" cy="180" r="90" fill="none" stroke="#fff1d2" stroke-width="14"/><text x="300" y="330" text-anchor="middle" fill="#35152b" font-family="serif" font-size="36">Test photo</text></svg>'
const source = `data:image/svg+xml,${encodeURIComponent(artwork)}`
const base: FamilyCapsule = {
  id: 'qa-weekly', kind: 'weekly', title: 'This week', weekStart: '2026-09-07',
  createdAt: '2026-09-07T00:00:00.000Z', createdByName: 'Test family',
  closesAt: '2026-09-14T00:00:00.000Z', opensAt: '2026-09-14T00:00:00.000Z',
  totalPhotoCount: 1, ownedByCurrentUser: true, photos: [{
    id: 'qa-photo', capsuleId: 'qa-weekly', image: source, thumbnail: source,
    width: 600, height: 400, capturedAt: '2026-09-10T12:00:00.000Z',
    caption: 'Our wonderfully long afternoon together at the family reunion',
    contributorName: 'Test family', ownedByCurrentUser: true,
  }],
}
const noAction = () => undefined
const actions = {
  now, uploading: false, demoUnlocked: false, allowLockedPreview: false,
  onChoosePhoto: noAction, onDemoUnlock: noAction,
}

function fixture(capsule: Partial<FamilyCapsule> & Pick<FamilyCapsule, 'id'>): FamilyCapsule {
  const result = { ...base, ...capsule }
  return {
    ...result,
    photos: result.photos.map((photo) => ({
      ...photo, id: `${result.id}-photo`, capsuleId: result.id,
      caption: `${result.id} · Our wonderfully long afternoon together at the family reunion`,
    })),
  }
}

const special = fixture({ id: 'qa-special', kind: 'special', title: 'SMAC DEMO DAY, FINALS and our wonderfully long family celebration', totalPhotoCount: 0, photos: [] })
const recentWeekly = fixture({ id: 'qa-recent-weekly', weekStart: '2026-08-31', opensAt: '2026-09-08T12:00:00.000Z', closesAt: '2026-09-08T12:00:00.000Z' })
const recentSpecial = fixture({ id: 'qa-recent-special', title: 'Four generations, one very special family afternoon', kind: 'special', opensAt: '2026-09-10T12:00:00.000Z', closesAt: '2026-09-10T12:00:00.000Z' })
const oldWeekly = fixture({ id: 'qa-old-weekly', weekStart: '2026-08-24', opensAt: '2026-09-08T11:59:59.999Z', closesAt: '2026-09-08T11:59:59.999Z' })
const oldSpecial = fixture({ id: 'qa-old-special', title: 'A wonderfully long special occasion with everyone', kind: 'special', opensAt: '2026-09-01T12:00:00.000Z', closesAt: '2026-09-01T12:00:00.000Z', ownedByCurrentUser: false })

export function CapsuleCardsQA() {
  const [status, setStatus] = useState('')
  const [opened, setOpened] = useState<FamilyCapsule | null>(null)
  function managementActions(capsule: FamilyCapsule) {
    if (!capsule.photos.some((photo) => photo.ownedByCurrentUser)) return null
    return <CapsulePhotoManager capsule={capsule} onDelete={() => {
        setStatus('Simulated photo deletion · no real photo')
        return Promise.resolve()
      }} />
  }
  function removalAction(capsule: FamilyCapsule) {
    return <ContentRemovalControl noun="Capsule" compact hideOnly={!capsule.ownedByCurrentUser}
        description={capsule.ownedByCurrentUser
          ? 'This removes the Capsule and its photos from the app for everyone in your family. Separate Journal uploads and videos already saved to a phone stay unchanged.'
          : 'This hides the Capsule from your Capsule page on this device. Its creator and your family keep it. You can restore hidden items below.'}
        onRemove={() => {
          setStatus('Simulated Capsule removal · no real Capsule')
          return Promise.resolve()
        }} />
  }
  function openRecap(capsule: FamilyCapsule) {
    setOpened(capsule)
    setStatus(`Simulated recap opened: ${capsule.id}`)
  }
  function card(capsule: FamilyCapsule) {
    return <CapsuleCard {...actions} capsule={capsule} onOpenRecap={openRecap}
      removalAction={removalAction(capsule)} managementActions={managementActions(capsule)} />
  }
  return <main className="capsules-page" style={{ width: '100%', minHeight: '100vh', paddingBlock: '1rem' }}>
    <p>Isolated card test · {document.documentElement.dataset.bubbleTheme}</p>
    <p role="status">{status}</p>
    <section className="capsule-page__section" aria-labelledby="weekly-capsule-title">
      <div className="capsule-section-heading"><h2 id="weekly-capsule-title">This week</h2></div>
      <CapsuleCard {...actions} capsule={base} onOpenRecap={openRecap} hideHeader managementActions={managementActions(base)} />
    </section>
    <section className="capsule-page__section" aria-labelledby="special-capsules-title">
      <h2 id="special-capsules-title">Special Capsules</h2>
      {card(special)}
      {card(recentSpecial)}
    </section>
    <section className="capsule-page__section" aria-labelledby="past-capsules-title" data-recap-history="true">
      <div className="capsule-section-heading"><h2 id="past-capsules-title">Past Capsules</h2></div>
      <ul className="capsule-weekly-carousel" aria-label="Past Capsules">
        <li>{card(recentWeekly)}</li>
        <li>{card(oldWeekly)}</li>
        <li>{card(oldSpecial)}</li>
      </ul>
    </section>
    {opened ? <section role="dialog" aria-modal="true" aria-label="Simulated recap" style={{ position: 'fixed', inset: 16, zIndex: 500, padding: 16, background: 'var(--color-surface, #fff1d2)', color: '#35152b', border: '2px solid #35152b', borderRadius: 24, overflow: 'auto' }}>
      <h2>{opened.title}</h2>
      <p>Fake test photo, shown only after deliberately opening.</p>
      <img src={source} alt={`Opened ${opened.id} test photo`} style={{ display: 'block', width: '100%', maxHeight: 420, objectFit: 'contain' }} />
      <button type="button" onClick={() => setOpened(null)} style={{ minHeight: 44, marginBlockStart: 16, paddingInline: 16 }}>Close simulated recap</button>
    </section> : null}
  </main>
}

createRoot(document.getElementById('root')!).render(<CapsuleCardsQA />)
