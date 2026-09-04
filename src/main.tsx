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
import { AuthBootstrapFailure } from './app/AuthBootstrapFailure'
import './theme/AppTheme.css'
import { installNativeViewportGeometrySync } from './app/nativeViewportGeometry'
import { clerkAppearance, clerkLocalization } from './clerkUi'
import { clerkConfigured } from './features/auth'
import { createNativeClerk } from './features/auth/nativeClerk'
import { nativeOAuthTransport } from './features/auth/nativeOAuthTransport'
import { initializeAppTheme } from './theme/AppTheme'

initializeAppTheme()
installNativeViewportGeometrySync()

/** Fails early with a useful message when the HTML entry point is incomplete. */
function requireApplicationRoot(): HTMLElement {
  const rootElement = document.getElementById('root')
  if (!rootElement) {
    throw new Error('Bubble could not start because the root element is missing.')
  }
  return rootElement
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim()
const nativeClerk = createNativeClerk(clerkPublishableKey)

// Native builds use a headless Clerk runtime and the in-app OAuth transport;
// browsers keep Clerk's standard popup flow. Both mount the same app routes.
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
      <AuthBootstrapFailure />
    </ClerkFailed>
  </ClerkProvider>
) : (
  <App />
)

createRoot(requireApplicationRoot()).render(
  <StrictMode>
    {app}
  </StrictMode>,
)
