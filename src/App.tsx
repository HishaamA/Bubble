import type { ReactNode } from 'react'
import { HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AppShell } from './app/AppShell'
import { ErrorBoundary } from './app/ErrorBoundary'
import {
  CaptureRoute,
  JournalRoute,
  MemoriesRoute,
  PanoramaRoute,
} from './app/MemoryExperienceRoutes'
import { CapsulesPage } from './features/capsules'
import {
  AuthPage,
  AuthProvider,
  RequireAuthentication,
  useAuth,
} from './features/auth'
import { EventsPage } from './features/events'
import { EventReminderCoordinator } from './features/events/EventReminderCoordinator'
import {
  FamilyMomentSyncProvider,
  SharedMomentsProvider,
} from './features/memories/shared'
import { ProfilePage } from './features/profile'
import { RelayPage } from './features/relay'
import {
  FamilyOnboardingProvider,
  OnboardingPage,
  RequireFamilyMembership,
  useFamilyOnboarding,
} from './features/onboarding'
import './App.css'

export function memberCacheNamespace(userId: string, familyId: string) {
  return `${userId}:${familyId}`
}

export function AccountScopedData({ children }: { children: ReactNode }) {
  const { status, user } = useAuth()
  const { snapshot } = useFamilyOnboarding()
  const familyId =
    snapshot?.kind === 'member' ? snapshot.membership.familyId : 'no-family'
  const cacheNamespace =
    status === 'signed-in' && user
      ? memberCacheNamespace(user.id, familyId)
      : 'signed-out:no-family'

  return (
    <SharedMomentsProvider
      key={cacheNamespace}
      cacheNamespace={cacheNamespace}
    >
      <FamilyMomentSyncProvider>{children}</FamilyMomentSyncProvider>
    </SharedMomentsProvider>
  )
}

function OnboardingRoute() {
  const { user } = useAuth()
  return <OnboardingPage key={user?.id ?? 'signed-out'} />
}

function MemberApplication() {
  return (
    <AccountScopedData>
      <AppShell>
        <Outlet />
      </AppShell>
    </AccountScopedData>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <EventReminderCoordinator />
        <FamilyOnboardingProvider>
          <HashRouter>
            <Routes>
              <Route path="/login" element={<AuthPage />} />
              <Route element={<RequireAuthentication />}>
                <Route path="/onboarding" element={<OnboardingRoute />} />
                <Route element={<RequireFamilyMembership />}>
                  <Route element={<MemberApplication />}>
                    <Route path="/" element={<MemoriesRoute />} />
                    <Route path="/journal" element={<JournalRoute />} />
                    <Route path="/memory/:memoryId" element={<PanoramaRoute />} />
                    <Route path="/capture" element={<CaptureRoute />} />
                    <Route path="/relay" element={<RelayPage />} />
                    <Route path="/capsules" element={<CapsulesPage />} />
                    <Route path="/events" element={<EventsPage />} />
                    <Route path="/profile" element={<ProfilePage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Route>
                </Route>
              </Route>
            </Routes>
          </HashRouter>
        </FamilyOnboardingProvider>
      </AuthProvider>
    </ErrorBoundary>
  )
}

export default App
