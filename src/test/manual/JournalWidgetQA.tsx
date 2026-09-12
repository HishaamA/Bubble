/** Isolated visual navigation fixture. No sign-in, private photos or remote writes. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AppTabBar } from '../../app/AppTabBar'
import { AuthContext, type AuthContextValue } from '../../features/auth/authContext'
import { FamilyOnboardingContext, type FamilyOnboardingContextValue } from '../../features/onboarding/familyOnboardingContext'
import { JournalPage } from '../../features/journal/JournalPage'
import type { JournalPhoto } from '../../features/journal/journalPhotoTypes'
import { parseBubbleWidgetDeepLink } from '../../features/widgets/widgetDeepLink'
import '../../index.css'
import '../../App.css'
import '../../theme/AppTheme.css'
import './FamilyScreenQA.css'

document.documentElement.dataset.bubbleTheme = 'plum'
const auth: AuthContextValue = {
  status: 'signed-out', user: null, getToken: async () => null, signOut: async () => undefined,
}
const family: FamilyOnboardingContextValue = {
  status: 'idle', snapshot: null, error: '', refreshing: false,
  refresh: async () => undefined, createFamily: async () => null, joinFamily: async () => null,
}
const photos: JournalPhoto[] = ['Oldest', 'Middle', 'Latest'].map((label, index) => {
  const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="650"><rect width="900" height="650" fill="${['#a5b37a', '#e6b5c4', '#7897d0'][index]}"/><circle cx="450" cy="290" r="150" fill="none" stroke="#fff1d2" stroke-width="20"/><text x="450" y="500" font-size="60" font-family="serif" text-anchor="middle" fill="#301027">${label} test photo</text></svg>`
  const source = `data:image/svg+xml,${encodeURIComponent(artwork)}`
  return {
    id: `qa-photo-${index + 1}`, image: source, thumbnail: source,
    width: 900, height: 650, caption: `${label} test photo`,
    capturedAt: `${2020 + index}-07-16T12:00:00.000Z`, contributorName: 'Test family',
    ownedByCurrentUser: true, syncStatus: 'synced',
  }
})

export function JournalWidgetQA() {
  const navigate = useNavigate()
  const location = useLocation()
  const [loaded, setLoaded] = useState(true)
  function openWidget() {
    const route = '/journal?photo=qa-photo-3&collection=family-photo-library&source=widget'
    const destination = parseBubbleWidgetDeepLink(`com.simerfamily.kinsphere://open?route=${encodeURIComponent(route)}`)
    if (destination) navigate(destination.to, { state: destination.state })
  }
  return <>
    <aside className="qa-controls" aria-label="Journal widget test controls">
      <strong>Isolated test · {location.pathname}</strong>
      <button type="button" onClick={openWidget}>Tap photo widget</button>
      <button type="button" onClick={() => setLoaded((value) => !value)}>{loaded ? 'Hide photos' : 'Load photos'}</button>
    </aside>
    <div className="app-viewport app-viewport--native qa-viewport" data-app-shell="native">
      <main className="app-content">
        <Routes>
          <Route path="/journal" element={<JournalPage
            capsuleCacheNamespace="qa-journal-widget:no-account"
            journalPhotos={loaded ? photos : []}
          />} />
          <Route path="/" element={<section><h1>Moments test destination</h1></section>} />
          <Route path="/capsule" element={<section><h1>Capsule test destination</h1></section>} />
        </Routes>
      </main>
      <div className="app-status-bar-backdrop" aria-hidden="true" />
      <AppTabBar />
    </div>
  </>
}

createRoot(document.getElementById('root')!).render(
  <AuthContext.Provider value={auth}>
    <FamilyOnboardingContext.Provider value={family}>
      <MemoryRouter initialEntries={['/journal']}><JournalWidgetQA /></MemoryRouter>
    </FamilyOnboardingContext.Provider>
  </AuthContext.Provider>,
)
