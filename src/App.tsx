import { lazy, Suspense, type PropsWithChildren } from 'react'
import { HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AccountScopedData } from './app/AccountScopedData'
import { createAccountCacheNamespace } from './app/accountCacheNamespace'
import { AppShell } from './app/AppShell'
import { ErrorBoundary } from './app/ErrorBoundary'
import { LegacyRouteRedirect } from './app/LegacyRouteRedirect'
import { AuthProvider, RequireAuthentication } from './features/auth/AuthProvider'
import { useAuth } from './features/auth/authContext'
import { EventReminderCoordinator } from './features/events/EventReminderCoordinator'
import { FamilyOnboardingProvider } from './features/onboarding/FamilyOnboardingProvider'
import { useFamilyOnboarding } from './features/onboarding/familyOnboardingContext'
import { OnboardingPage } from './features/onboarding/OnboardingPage'
import { RequireFamilyMembership } from './features/onboarding/RequireFamilyMembership'
import './App.css'

// Each screen is a separate dynamic entry. The initial app shell therefore
// downloads only the route the member opens, while feature CSS follows that
// route instead of being bundled into every launch.
const AuthPage = lazy(() => import('./features/auth/AuthPage').then((module) => ({
  default: module.AuthPage,
})))
const MemoriesRoute = lazy(() => import('./app/routes/MemoriesRoutes').then((module) => ({
  default: module.MemoriesRoute,
})))
const PanoramaRoute = lazy(() => import('./app/routes/MemoriesRoutes').then((module) => ({
  default: module.PanoramaRoute,
})))
const CaptureRoute = lazy(() => import('./app/routes/CaptureRoute').then((module) => ({
  default: module.CaptureRoute,
})))
const JournalRoute = lazy(() => import('./app/routes/JournalRoutes').then((module) => ({
  default: module.JournalRoute,
})))
const CapsulePhotoRoute = lazy(() => import('./app/routes/JournalRoutes').then((module) => ({
  default: module.CapsulePhotoRoute,
})))
const CapsulesPage = lazy(() => import('./features/capsules/CapsulesPage').then((module) => ({
  default: module.CapsulesPage,
})))
const SettingsPage = lazy(() => import('./features/profile/ProfilePage').then((module) => ({
  default: module.SettingsPage,
})))

/** Keeps route transitions inside the themed app while a lazy chunk arrives. */
function RouteLoading() {
  return (
    <section className="app-route-loading" role="status" aria-label="Loading page">
      <span aria-hidden="true" />
    </section>
  )
}

/** Supplies the same lightweight fallback to public lazy routes. */
function DeferredRoute({ children }: PropsWithChildren) {
  return <Suspense fallback={<RouteLoading />}>{children}</Suspense>
}

/** Preserves the Journal plans context when resolving the retired event route. */
function openPlansFromLegacyEventRoute(state: unknown) {
  // Old links still land in the right Journal tab without discarding the
  // caller's focus and scroll restoration state.
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

/** Keeps signed-in preview sessions out of the production onboarding flow. */
function OnboardingRoute() {
  const { isDevelopmentPreview, user } = useAuth()
  if (isDevelopmentPreview) return <Navigate to="/" replace />
  return (
    <DeferredRoute>
      <OnboardingPage key={user?.id ?? 'signed-out'} />
    </DeferredRoute>
  )
}

/** Returns the cache partition for the current account and family membership. */
function useActiveMemberCacheNamespace() {
  const { user } = useAuth()
  const { snapshot } = useFamilyOnboarding()
  const familyId = snapshot?.kind === 'member'
    ? snapshot.membership.familyId
    : 'no-family'
  return createAccountCacheNamespace(user?.id ?? 'signed-out', familyId)
}

/** Supplies the active cache partition to the Capsule feature. */
function CapsuleRoute() {
  const cacheNamespace = useActiveMemberCacheNamespace()
  return (
    <CapsulesPage cacheNamespace={cacheNamespace} />
  )
}

/** Supplies the active cache partition to the Journal feature. */
function JournalMemberRoute() {
  const cacheNamespace = useActiveMemberCacheNamespace()
  return (
    <JournalRoute capsuleCacheNamespace={cacheNamespace} />
  )
}

/** Supplies the active cache partition to the full-screen photo viewer. */
function CapsulePhotoMemberRoute() {
  const cacheNamespace = useActiveMemberCacheNamespace()
  return (
    <CapsulePhotoRoute capsuleCacheNamespace={cacheNamespace} />
  )
}

/** Wraps every member route in the shell and account-scoped data providers. */
function MemberApplication() {
  return (
    <AccountScopedData>
      <AppShell>
        <Suspense fallback={<RouteLoading />}>
          <Outlet />
        </Suspense>
      </AppShell>
    </AccountScopedData>
  )
}

/** Declares authentication, membership, and member-only application routes. */
function App() {
  // Authentication and family membership are separate gates: a valid account
  // must never bootstrap family-scoped providers before membership is known.
  return (
    <ErrorBoundary>
      <AuthProvider>
        <FamilyOnboardingProvider>
          <EventReminderCoordinator />
          <HashRouter>
            <Routes>
              <Route
                path="/login"
                element={
                  <DeferredRoute>
                    <AuthPage />
                  </DeferredRoute>
                }
              />
              <Route element={<RequireAuthentication />}>
                <Route path="/onboarding" element={<OnboardingRoute />} />
                <Route element={<RequireFamilyMembership />}>
                  <Route element={<MemberApplication />}>
                    <Route path="/" element={<MemoriesRoute />} />
                    <Route path="/journal" element={<JournalMemberRoute />} />
                    <Route
                      path="/journal/person/:personId"
                      element={<JournalMemberRoute />}
                    />
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
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route
                      path="/profile/*"
                      element={<Navigate to="/settings" replace />}
                    />
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
