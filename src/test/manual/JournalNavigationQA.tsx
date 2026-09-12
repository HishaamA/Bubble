/** Isolated navigation fixture: synthetic photos and local test metadata only. */
import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AppTabBar } from '../../app/AppTabBar'
import { AuthContext, type AuthContextValue } from '../../features/auth/authContext'
import { FamilyOnboardingContext, type FamilyOnboardingContextValue } from '../../features/onboarding/familyOnboardingContext'
import { JournalPage } from '../../features/journal/JournalPage'
import type { JournalPhoto } from '../../features/journal/journalPhotoTypes'
import { emptyPeopleTimelineState, savePeopleTimelineState } from '../../features/journal/people/peopleTimelineStore'
import { preloadPeopleTimelineSession } from '../../features/journal/people/peopleTimelineSession'
import { parseBubbleWidgetDeepLink } from '../../features/widgets/widgetDeepLink'
import '../../index.css'
import '../../App.css'
import '../../theme/AppTheme.css'
import './FamilyScreenQA.css'

const namespace = 'qa-journal-navigation:no-account'
const parameters = new URLSearchParams(window.location.search)
document.documentElement.dataset.bubbleTheme = parameters.get('theme') ?? 'plum'
const auth: AuthContextValue = {
  status: 'signed-out', user: null, getToken: async () => null, signOut: async () => undefined,
}
const family: FamilyOnboardingContextValue = {
  status: 'idle', snapshot: null, error: '', refreshing: false,
  refresh: async () => undefined, createFamily: async () => null, joinFamily: async () => null,
}
const photos: JournalPhoto[] = Array.from({ length: 6 }, (_, index) => {
  const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="650"><rect width="900" height="650" fill="${['#a5b37a', '#e6b5c4', '#7897d0'][index % 3]}"/><circle cx="450" cy="290" r="150" fill="none" stroke="#fff1d2" stroke-width="20"/><text x="450" y="500" font-size="60" font-family="serif" text-anchor="middle" fill="#301027">Test photo ${index + 1}</text></svg>`
  const source = new Blob([artwork], { type: 'image/svg+xml' })
  return {
    id: `qa-photo-${index + 1}`, image: source, thumbnail: source,
    width: 900, height: 650, caption: `Test photo ${index + 1}`,
    capturedAt: `${2020 + index}-07-16T12:00:00.000Z`, contributorName: 'Test family',
    ownedByCurrentUser: true, syncStatus: 'synced',
  }
})
const state = emptyPeopleTimelineState()
state.people = ['Maya', 'Lina', 'Sami'].map((name) => ({ id: name.toLowerCase(), name, createdAt: '2026-01-01T00:00:00Z' }))
state.assignments = photos.map((photo, index) => ({
  photoKey: `journal-photo:${photo.id}`, personId: state.people[index % 3].id,
  source: 'manual', confirmedAt: '2026-01-01T00:00:00Z',
}))
state.faceScans = Object.fromEntries(photos.map((photo) => [
  `journal-photo:${photo.id}`, { scannedAt: '2026-01-01T00:00:00Z', faces: [] },
]))

type Frame = {
  kind: 'commit' | 'paint'; key: string; people: number; albums: number; loading: boolean; sources: string[]
  images: Array<{ complete: boolean; naturalWidth: number }>
}
const metrics = { creates: 0, revokes: 0, frames: [] as Frame[] }
const originalCreate = URL.createObjectURL.bind(URL)
const originalRevoke = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (source) => { metrics.creates += 1; return originalCreate(source) }
URL.revokeObjectURL = (source) => { metrics.revokes += 1; originalRevoke(source) }
Object.assign(window, { journalNavigationMetrics: metrics })

function recordFrame(kind: Frame['kind'], key: string) {
  metrics.frames.push({
    kind, key,
    people: document.querySelectorAll('.people-timeline__setup-person:not(.people-timeline__setup-person--empty)').length,
    albums: document.querySelectorAll('.people-timeline__album-tile').length,
    loading: /Loading people|Add your first person/.test(document.querySelector('.journal-page')?.textContent ?? ''),
    sources: [...document.querySelectorAll<HTMLImageElement>('.people-timeline__photo-image')].map((image) => image.getAttribute('src') ?? ''),
    images: [...document.querySelectorAll<HTMLImageElement>('.people-timeline__photo-image')].map((image) => ({ complete: image.complete, naturalWidth: image.naturalWidth })),
  })
}

export function ObservedJournal() {
  const { key } = useLocation()
  useLayoutEffect(() => {
    recordFrame('commit', key)
    const frame = requestAnimationFrame(() => recordFrame('paint', key))
    return () => cancelAnimationFrame(frame)
  }, [key])
  return <JournalPage capsuleCacheNamespace={namespace} journalPhotos={photos} />
}

export function NavigationFixture() {
  const navigate = useNavigate()
  const location = useLocation()
  function openWidget() {
    const route = '/journal?photo=qa-photo-6&collection=family-photo-library&source=widget'
    const destination = parseBubbleWidgetDeepLink(`com.simerfamily.kinsphere://open?route=${encodeURIComponent(route)}`)
    if (destination) navigate(destination.to, { state: destination.state })
  }
  return <>
    <aside className="qa-controls" aria-label="Journal navigation test controls">
      <strong>Isolated test · {location.pathname}</strong>
      <button type="button" onClick={openWidget}>Tap photo widget</button>
      <button type="button" onClick={() => navigate('/profile')}>Open test profile</button>
    </aside>
    <div className="app-viewport app-viewport--native qa-viewport" data-app-shell="native">
      <main className="app-content"><Routes>
        <Route path="/journal" element={<ObservedJournal />} />
        <Route path="/journal/person/:personId" element={<ObservedJournal />} />
        <Route path="/" element={<section><h1>Moments test destination</h1></section>} />
        <Route path="/capsule" element={<section><h1>Capsule test destination</h1></section>} />
        <Route path="/profile" element={<section><h1>Profile test destination</h1></section>} />
      </Routes></main>
      <div className="app-status-bar-backdrop" aria-hidden="true" />
      <AppTabBar />
    </div>
  </>
}

void savePeopleTimelineState(namespace, state).then(async () => {
  if (parameters.get('warm') !== 'false') await preloadPeopleTimelineSession(namespace)
  createRoot(document.getElementById('root')!).render(
    <AuthContext.Provider value={auth}><FamilyOnboardingContext.Provider value={family}>
      <MemoryRouter initialEntries={['/journal']}><NavigationFixture /></MemoryRouter>
    </FamilyOnboardingContext.Provider></AuthContext.Provider>,
  )
})
