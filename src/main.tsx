import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
} from '@clerk/react'
import './index.css'
import App from './App.tsx'
import './theme/AppTheme.css'
import { installNativeViewportGeometrySync } from './app/nativeViewportGeometry'
import { clerkAppearance, clerkLocalization } from './clerkUi'
import { clerkConfigured } from './features/auth'
import { createNativeClerk } from './features/auth/nativeClerk'
import { nativeOAuthTransport } from './features/auth/nativeOAuthTransport'
import { initializeAppTheme } from './theme/AppTheme'

initializeAppTheme()
installNativeViewportGeometrySync()

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim()
const nativeClerk = createNativeClerk(clerkPublishableKey)

const app = clerkConfigured ? (
  <ClerkProvider
    Clerk={nativeClerk}
    appearance={clerkAppearance}
    __internal_oauthTransport={nativeOAuthTransport}
    experimental={nativeClerk ? { runtimeEnvironment: 'headless' } : undefined}
    localization={clerkLocalization}
    publishableKey={clerkPublishableKey}
    standardBrowser={!nativeClerk}
  >
    <ClerkLoading>
      <section className="auth-loading" role="status">
        <span aria-hidden="true" />
        Preparing secure sign-in…
      </section>
    </ClerkLoading>
    <ClerkLoaded>
      <App />
    </ClerkLoaded>
    <ClerkFailed>
      <section className="auth-bootstrap-failed" role="alert">
        <p className="auth-bootstrap-failed__eyebrow">Bubble sign-in</p>
        <h1>We couldn’t open sign-in.</h1>
        <p>
          Sign-in is temporarily unavailable. Try again in a moment. Your
          family data has not been changed.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </section>
    </ClerkFailed>
  </ClerkProvider>
) : (
  <App />
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {app}
  </StrictMode>,
)
