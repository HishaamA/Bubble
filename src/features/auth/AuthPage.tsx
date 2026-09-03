import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from './authContext'
import { AuthFamilyIllustration } from './AuthFamilyIllustration'
import { EmailCodeAuthFlow } from './EmailCodeAuthFlow'
import { getSafeReturnPath } from './returnPath'
import './AuthPage.css'

const AUTH_RETURN_TO_STORAGE_KEY = 'kinsphere.auth.returnTo'
const AUTH_BLOCKED_ROUTES = ['/login'] as const
const DEMO_BLOCKED_ROUTES = ['/login', '/onboarding'] as const

/** Reads the pending post-authentication route without assuming storage access. */
function storedReturnTo() {
  if (typeof window === 'undefined') return undefined
  try {
    return window.sessionStorage.getItem(AUTH_RETURN_TO_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** Persists only a sanitized in-app route for the next authentication render. */
function rememberReturnTo(returnPath: string) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(
      AUTH_RETURN_TO_STORAGE_KEY,
      getSafeReturnPath(returnPath, AUTH_BLOCKED_ROUTES),
    )
  } catch {
    // Restricted web views can disable storage. The safe fallback is home.
  }
}

/** Clears the one-shot return route after authentication has consumed it. */
function clearStoredReturnTo() {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(AUTH_RETURN_TO_STORAGE_KEY)
  } catch {
    // Restricted web views can disable storage.
  }
}

/** Performs a replace navigation only after the signed-in screen has mounted. */
function SignedInRedirect({ to }: { to: string }) {
  const navigate = useNavigate()

  useEffect(() => {
    clearStoredReturnTo()
    navigate(to, { replace: true })
  }, [navigate, to])

  return (
    <section className="auth-loading" role="status">
      <span aria-hidden="true" />
      Opening your family space…
    </section>
  )
}

/** Explains unavailable cloud authentication while exposing approved local access. */
function ClerkConfigurationState({
  onContinue,
  testingMode,
}: {
  onContinue?: () => void
  testingMode?: boolean
}) {
  return (
    <div className="auth-card__setup" role="status">
      <strong>
        {testingMode ? 'Test access enabled' : 'Clerk connection required'}
      </strong>
      {testingMode ? (
        <p>
          Continue without an account to test the local interface and native
          capture tools. Cloud family sync stays disabled in this test session.
        </p>
      ) : (
        <p>
          Add <code>VITE_CLERK_PUBLISHABLE_KEY</code> to a local environment
          file, then restart the app for account access. Until then, use the
          local demo below; cloud family sync remains off in demo mode.
        </p>
      )}
      {onContinue ? (
        <div className="auth-card__preview">
          <button type="button" onClick={onContinue}>
            {testingMode ? 'Continue without signing in' : 'Explore the demo'}
          </button>
          <small>
            {testingMode
              ? 'Debug APK only · family sync stays offline'
              : 'Demo mode · family sync stays offline'}
          </small>
        </div>
      ) : null}
    </div>
  )
}

/** Offers the product demo without presenting it as a cloud-authenticated session. */
function DemoLoginAction({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="auth-demo-action">
      <button type="button" onClick={onContinue}>
        Explore the demo <span aria-hidden="true">→</span>
      </button>
      <small>Cloud family sync stays off in demo mode.</small>
    </div>
  )
}

/** Presents sign-in choices and returns authenticated users to their safe route. */
export function AuthPage() {
  const [authOpen, setAuthOpen] = useState(false)
  const {
    isDevelopmentPreview,
    isTestAccess,
    startDevelopmentPreview,
    status,
    user,
  } = useAuth()
  const location = useLocation()
  const requestedReturnTo = (
    location.state as { returnTo?: unknown } | null
  )?.returnTo
  const returnTo = getSafeReturnPath(
    requestedReturnTo ?? storedReturnTo(),
    AUTH_BLOCKED_ROUTES,
  )
  const demoReturnTo = getSafeReturnPath(returnTo, DEMO_BLOCKED_ROUTES)
  const continueToDemo = startDevelopmentPreview
    ? () => {
        rememberReturnTo(demoReturnTo)
        startDevelopmentPreview()
      }
    : undefined

  if (status === 'signed-in' && user) {
    return (
      <SignedInRedirect to={isDevelopmentPreview ? demoReturnTo : returnTo} />
    )
  }

  return (
    <section className="auth-page" aria-labelledby="auth-title">
      <header className="auth-page__brand">
        <p>Bubble</p>
      </header>

      <AuthFamilyIllustration />

      <div className="auth-card">
        <div className="auth-card__intro">
          <h1 id="auth-title">Big days. Little moments. Never missed.</h1>
          <p>
            Keep every celebration, plan, and everyday memory close, wherever
            your family is.
          </p>
        </div>

        {status === 'loading' ? (
          <div className="auth-card__loading" role="status">
            <span aria-hidden="true" /> Getting things ready…
          </div>
        ) : null}

        {status === 'unconfigured' ? (
          <ClerkConfigurationState
            testingMode={isTestAccess}
            onContinue={continueToDemo}
          />
        ) : null}

        {status === 'signed-out' ? (
          <div className="auth-actions">
            <button
              className="auth-actions__primary"
              type="button"
              aria-haspopup="dialog"
              aria-expanded={authOpen}
              onClick={() => setAuthOpen(true)}
            >
              Get started
            </button>
          </div>
        ) : null}

        {continueToDemo && status !== 'unconfigured' ? (
          <DemoLoginAction onContinue={continueToDemo} />
        ) : null}
      </div>

      {status === 'signed-out' && authOpen ? (
        <EmailCodeAuthFlow
          onClose={() => setAuthOpen(false)}
          onStart={() => rememberReturnTo(returnTo)}
        />
      ) : null}
    </section>
  )
}
