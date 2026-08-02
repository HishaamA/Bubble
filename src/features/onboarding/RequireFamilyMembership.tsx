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
      state={{ returnTo: `${location.pathname}${location.search}` }}
    />
  )
}
