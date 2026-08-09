import { SignInButton, SignUpButton } from '@clerk/react'
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from './authContext'
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
}: {
  onContinue?: () => void
}) {
  return (
    <div className="auth-card__setup" role="status">
      <strong>Clerk connection required</strong>
      <p>
        Add <code>VITE_CLERK_PUBLISHABLE_KEY</code> to a local environment
        file, then restart the app. Sign-in stays locked until Clerk is
        connected; production never falls back to an unsecured preview.
      </p>
      {onContinue ? (
        <div className="auth-card__preview">
          <button type="button" onClick={onContinue}>
            Proceed to app
          </button>
          <small>Temporary preview · family sync stays offline</small>
        </div>
      ) : null}
    </div>
  )
}

export function AuthPage() {
  const { startDevelopmentPreview, status, user } = useAuth()
  const location = useLocation()
  const requestedReturnTo = (
    location.state as { returnTo?: unknown } | null
  )?.returnTo
  const returnTo = safeReturnTo(requestedReturnTo ?? storedReturnTo())

  if (status === 'signed-in' && user) {
    return <SignedInRedirect to={returnTo} />
  }

  return (
    <section className="auth-page" aria-labelledby="auth-title">
      <div className="auth-page__halo" aria-hidden="true" />
      <header className="auth-page__brand">
        <span aria-hidden="true">K</span>
        <p>KinSphere</p>
      </header>

      <div className="auth-card">
        <div className="auth-card__intro">
          <p className="auth-card__eyebrow">A private place for your people</p>
          <h1 id="auth-title">Come home to your family.</h1>
          <p>
            Keep the small moments, make plans, and feel close—even when
            everyone is somewhere else.
          </p>
        </div>

        {status === 'loading' ? (
          <div className="auth-card__loading" role="status">
            <span aria-hidden="true" /> Preparing secure sign-in…
          </div>
        ) : null}

        {status === 'unconfigured' ? (
          <ClerkConfigurationState
            onContinue={
              startDevelopmentPreview
                ? () => {
                    rememberReturnTo(returnTo)
                    startDevelopmentPreview()
                  }
                : undefined
            }
          />
        ) : null}

        {status === 'signed-out' ? (
          <div className="auth-actions">
            <SignInButton mode="modal">
              <button
                className="auth-actions__primary"
                type="button"
                onClick={() => rememberReturnTo(returnTo)}
              >
                Sign in
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button
                className="auth-actions__secondary"
                type="button"
                onClick={() => rememberReturnTo(returnTo)}
              >
                Create an account
              </button>
            </SignUpButton>
            <p>Continue securely with Google, Apple, or your phone.</p>
          </div>
        ) : null}
      </div>

      <p className="auth-page__privacy">
        Your family space stays private. Invite codes are shared by you, never
        listed publicly.
      </p>
    </section>
  )
}
