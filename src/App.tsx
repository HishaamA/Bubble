import type { ReactNode } from 'react'
import { HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AppShell } from './app/AppShell'
import { ErrorBoundary } from './app/ErrorBoundary'
import { LegacyRouteRedirect } from './app/LegacyRouteRedirect'
import {
  CapsulePhotoRoute,
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

function openPlansFromLegacyEventRoute(state: unknown) {
  const routeState = state && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {}
  const existingContext = routeState.journalContext
  const journalContext = existingContext
    && typeof existingContext === 'object'
    && !Array.isArray(existingContext)
    ? existingContext as Record<string, unknown>
    : {}

  return {
    ...routeState,
    journalContext: {
      ...journalContext,
      section: 'plans',
    },
  }
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
  const { isDevelopmentPreview, user } = useAuth()
  if (isDevelopmentPreview) return <Navigate to="/" replace />
  return <OnboardingPage key={user?.id ?? 'signed-out'} />
}

function useActiveMemberCacheNamespace() {
  const { user } = useAuth()
  const { snapshot } = useFamilyOnboarding()
  const familyId = snapshot?.kind === 'member'
    ? snapshot.membership.familyId
    : 'no-family'
  return memberCacheNamespace(user?.id ?? 'signed-out', familyId)
}

function CapsuleRoute() {
  const cacheNamespace = useActiveMemberCacheNamespace()
  return (
    <CapsulesPage cacheNamespace={cacheNamespace} />
  )
}

function JournalMemberRoute() {
  const cacheNamespace = useActiveMemberCacheNamespace()
  return (
    <JournalRoute capsuleCacheNamespace={cacheNamespace} />
  )
}

function CapsulePhotoMemberRoute() {
  const cacheNamespace = useActiveMemberCacheNamespace()
  return (
    <CapsulePhotoRoute capsuleCacheNamespace={cacheNamespace} />
  )
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
        <FamilyOnboardingProvider>
          <EventReminderCoordinator />
          <HashRouter>
            <Routes>
              <Route path="/login" element={<AuthPage />} />
              <Route element={<RequireAuthentication />}>
                <Route path="/onboarding" element={<OnboardingRoute />} />
                <Route element={<RequireFamilyMembership />}>
                  <Route element={<MemberApplication />}>
                    <Route path="/" element={<MemoriesRoute />} />
                    <Route path="/journal" element={<JournalMemberRoute />} />
                    <Route
                      path="/journal/photo/:capsuleId/:photoId"
                      element={<CapsulePhotoMemberRoute />}
                    />
                    <Route
                      path="/journal/library/:photoId"
                      element={<CapsulePhotoMemberRoute />}
                    />
                    <Route path="/memory/:memoryId" element={<PanoramaRoute />} />
                    <Route path="/capture" element={<CaptureRoute />} />
                    <Route path="/relay" element={<RelayPage />} />
                    <Route path="/capsule/*" element={<CapsuleRoute />} />
                    <Route
                      path="/capsules/*"
                      element={
                        <LegacyRouteRedirect
                          fromBase="/capsules"
                          toBase="/capsule"
                          preservePathSuffix
                        />
                      }
                    />
                    <Route
                      path="/events/*"
                      element={
                        <LegacyRouteRedirect
                          fromBase="/events"
                          toBase="/journal"
                          mapState={openPlansFromLegacyEventRoute}
                        />
                      }
                    />
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
