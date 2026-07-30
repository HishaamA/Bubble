import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './app/AppShell'
import { ErrorBoundary } from './app/ErrorBoundary'
import {
  CaptureRoute,
  MemoriesRoute,
  PanoramaRoute,
} from './app/MemoryExperienceRoutes'
import { CapsulesPage } from './features/capsules'
import { EventsPage } from './features/events'
import {
  FamilyMomentSyncProvider,
  SharedMomentsProvider,
} from './features/memories/shared'
import { ProfilePage } from './features/profile'
import { RelayPage } from './features/relay'
import './App.css'

function App() {
  return (
    <ErrorBoundary>
      <SharedMomentsProvider>
        <FamilyMomentSyncProvider>
          <HashRouter>
            <AppShell>
              <Routes>
                <Route path="/" element={<MemoriesRoute />} />
                <Route path="/memory/:memoryId" element={<PanoramaRoute />} />
                <Route path="/capture" element={<CaptureRoute />} />
                <Route path="/relay" element={<RelayPage />} />
                <Route path="/capsules" element={<CapsulesPage />} />
                <Route path="/events" element={<EventsPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppShell>
          </HashRouter>
        </FamilyMomentSyncProvider>
      </SharedMomentsProvider>
    </ErrorBoundary>
  )
}

export default App
