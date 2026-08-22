import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from './authContext'
import { AuthFamilyIllustration } from './AuthFamilyIllustration'
import { EmailCodeAuthFlow } from './EmailCodeAuthFlow'
import './AuthPage.css'

const AUTH_RETURN_TO_STORAGE_KEY = 'kinsphere.auth.returnTo'
const INTERNAL_RETURN_TO_ORIGIN = 'https://kinsphere.local'

function safeReturnTo(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//')
  ) {
    return '/'
  }

  try {
    const target = new URL(value, INTERNAL_RETURN_TO_ORIGIN)
    if (
      target.origin !== INTERNAL_RETURN_TO_ORIGIN ||
      target.pathname === '/login' ||
      target.pathname.startsWith('/login/')
    ) {
      return '/'
    }
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return '/'
  }
}

function safeDemoReturnTo(value: unknown) {
  const safeValue = safeReturnTo(value)
  const target = new URL(safeValue, INTERNAL_RETURN_TO_ORIGIN)
  return target.pathname === '/onboarding' ||
    target.pathname.startsWith('/onboarding/')
    ? '/'
    : safeValue
}

function storedReturnTo() {
  if (typeof window === 'undefined') return undefined
  try {
    return window.sessionStorage.getItem(AUTH_RETURN_TO_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function rememberReturnTo(value: string) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(
      AUTH_RETURN_TO_STORAGE_KEY,
      safeReturnTo(value),
    )
  } catch {
    // Restricted web views can disable storage. The safe fallback is home.
  }
}

function clearStoredReturnTo() {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(AUTH_RETURN_TO_STORAGE_KEY)
  } catch {
    // Restricted web views can disable storage.
  }
}

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
  const returnTo = safeReturnTo(requestedReturnTo ?? storedReturnTo())
  const demoReturnTo = safeDemoReturnTo(returnTo)
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
