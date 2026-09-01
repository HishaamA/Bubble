import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth'
import { useFamilyOnboarding } from './FamilyOnboardingProvider'

export function RequireFamilyMembership() {
  const { isDevelopmentPreview } = useAuth()
  const { status } = useFamilyOnboarding()
  const location = useLocation()

  if (isDevelopmentPreview) return <Outlet />
  if (status === 'member') return <Outlet />

  if (status === 'idle' || status === 'loading') {
    return (
      <section className="onboarding-loading" role="status">
        <span aria-hidden="true" />
        Finding your family…
      </section>
    )
  }

  return (
    <Navigate
      to="/onboarding"
      replace
      state={{
        // Family setup is a temporary gate, not a new destination. Preserve the
        // entire in-app deep link so joining a family returns to the exact view.
        returnTo: `${location.pathname}${location.search}${location.hash}`,
      }}
    />
  )
}
