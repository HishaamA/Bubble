import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react'
import {
  useAuth as useClerkAuth,
  useClerk,
  useUser,
} from '@clerk/react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { configureClerkSupabaseSession } from '../../lib/supabase'
import {
  AuthContext,
  useAuth,
  type AuthContextValue,
} from './authContext'
import type { AuthUser } from './types'
import { clerkConfigured } from './config'
import {
  clearDevelopmentPreviewSession,
  developmentPreviewAvailable,
  developmentPreviewUser,
  readDevelopmentPreviewSession,
  startDevelopmentPreviewSession,
} from './developmentPreview'

const missingClerkValue: AuthContextValue = {
  status: 'unconfigured',
  user: null,
  getToken: async () => null,
  signOut: async () => undefined,
}

function DevelopmentPreviewAuthProvider({ children }: PropsWithChildren) {
  const [previewActive, setPreviewActive] = useState(
    readDevelopmentPreviewSession,
  )

  const value = useMemo<AuthContextValue>(() => {
    if (!previewActive) {
      return {
        ...missingClerkValue,
        startDevelopmentPreview: developmentPreviewAvailable
          ? () => {
              if (startDevelopmentPreviewSession()) setPreviewActive(true)
            }
          : undefined,
      }
    }

    return {
      status: 'signed-in',
      user: developmentPreviewUser,
      getToken: async () => null,
      isDevelopmentPreview: true,
      signOut: async () => {
        clearDevelopmentPreviewSession()
        setPreviewActive(false)
      },
    }
  }, [previewActive])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function ClerkAuthBridge({ children }: PropsWithChildren) {
  const {
    getToken: getClerkToken,
    isLoaded,
    isSignedIn,
    sessionId,
  } = useClerkAuth()
  const { user } = useUser()
  const { signOut: clerkSignOut } = useClerk()
  const [connectedSession, setConnectedSession] = useState<string | null>(null)

  const getToken = useCallback(
    (options?: { template?: string }) => getClerkToken(options),
    [getClerkToken],
  )
  const signOut = useCallback(async () => {
    await clerkSignOut()
  }, [clerkSignOut])

  const authUser = useMemo<AuthUser | null>(() => {
    if (!user) return null
    const primaryEmail =
      user.primaryEmailAddress?.emailAddress ??
      user.emailAddresses[0]?.emailAddress ??
      null
    const primaryPhone =
      user.primaryPhoneNumber?.phoneNumber ??
      user.phoneNumbers[0]?.phoneNumber ??
      null
    const displayName =
      user.fullName?.trim() ||
      user.firstName?.trim() ||
      primaryEmail?.split('@')[0] ||
      'Family member'

    return {
      id: user.id,
      displayName,
      email: primaryEmail,
      phone: primaryPhone,
      imageUrl: user.imageUrl || null,
    }
  }, [user])

  const expectedSession =
    isLoaded && isSignedIn && sessionId && authUser
      ? `${sessionId}:${authUser.id}`
      : null

  useEffect(() => {
    if (!expectedSession || !authUser) {
      const clearConnection = window.setTimeout(
        () => setConnectedSession(null),
        0,
      )
      return () => window.clearTimeout(clearConnection)
    }
    const disconnect = configureClerkSupabaseSession({
      accessToken: () => getClerkToken(),
      identity: () => ({
        subject: authUser.id,
        displayName: authUser.displayName,
        email: authUser.email,
      }),
      signOut,
    })
    const publishConnection = window.setTimeout(
      () => setConnectedSession(expectedSession),
      0,
    )
    return () => {
      window.clearTimeout(publishConnection)
      disconnect()
    }
  }, [authUser, expectedSession, getClerkToken, signOut])

  const value = useMemo<AuthContextValue>(() => {
    if (
      !isLoaded ||
      (isSignedIn && connectedSession !== expectedSession)
    ) {
      return { status: 'loading', user: null, getToken, signOut }
    }

    if (!isSignedIn || !authUser) {
      return { status: 'signed-out', user: null, getToken, signOut }
    }

    return {
      status: 'signed-in',
      user: authUser,
      getToken,
      signOut,
    }
  }, [
    authUser,
    connectedSession,
    expectedSession,
    getToken,
    isLoaded,
    isSignedIn,
    signOut,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function AuthProvider({
  children,
  value,
}: PropsWithChildren<{ value?: AuthContextValue }>) {
  if (value) {
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  }

  if (!clerkConfigured) {
    return <DevelopmentPreviewAuthProvider>{children}</DevelopmentPreviewAuthProvider>
  }

  return <ClerkAuthBridge>{children}</ClerkAuthBridge>
}

export function RequireAuthentication() {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <section className="auth-loading" role="status">
        <span aria-hidden="true" />
        Opening your family space…
      </section>
    )
  }

  if (status === 'signed-out' || status === 'unconfigured') {
    return (
      <Navigate
        to="/login"
        replace
        state={{ returnTo: `${location.pathname}${location.search}` }}
      />
    )
  }

  return <Outlet />
}
