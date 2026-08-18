import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
import {
  clearDemoLoginSession,
  demoLoginAvailable,
  readDemoLoginSession,
  startDemoLoginSession,
} from './demoLogin'
import { isNativeTestAccessEnabled } from './nativeTestAccess'
import { cancelActiveSubjectFlightNotifications } from '../flights/flightNotifications'

const missingClerkValue: AuthContextValue = {
  status: 'unconfigured',
  user: null,
  getToken: async () => null,
  signOut: async () => undefined,
}

function DevelopmentPreviewAuthProvider({
  children,
  autoStart = false,
  testAccess = false,
  startDemo,
}: PropsWithChildren<{
  autoStart?: boolean
  testAccess?: boolean
  startDemo?: () => void
}>) {
  const [previewActive, setPreviewActive] = useState(
    () => autoStart || readDevelopmentPreviewSession(),
  )

  const value = useMemo<AuthContextValue>(() => {
    if (!previewActive) {
      return {
        ...missingClerkValue,
        isTestAccess: testAccess,
        startDevelopmentPreview:
          developmentPreviewAvailable || testAccess
            ? () => {
                if (testAccess || startDevelopmentPreviewSession()) {
                  setPreviewActive(true)
                }
              }
            : startDemo,
      }
    }

    return {
      status: 'signed-in',
      user: developmentPreviewUser,
      getToken: async () => null,
      isDevelopmentPreview: true,
      isTestAccess: testAccess,
      signOut: async () => {
        await cancelActiveSubjectFlightNotifications()
        clearDevelopmentPreviewSession()
        setPreviewActive(false)
      },
    }
  }, [previewActive, startDemo, testAccess])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function DemoLoginAuthProvider({
  children,
  onSignOut,
}: PropsWithChildren<{ onSignOut: () => void }>) {
  const value = useMemo<AuthContextValue>(() => ({
    status: 'signed-in',
    user: developmentPreviewUser,
    getToken: async () => null,
    isDevelopmentPreview: true,
    signOut: async () => {
      clearDemoLoginSession()
      clearDevelopmentPreviewSession()
      onSignOut()
    },
  }), [onSignOut])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

const checkingNativeAccessValue: AuthContextValue = {
  status: 'loading',
  user: null,
  getToken: async () => null,
  signOut: async () => undefined,
}

function RuntimeAuthProvider({ children }: PropsWithChildren) {
  const [testAccess, setTestAccess] = useState<boolean | null>(null)
  const [demoActive, setDemoActive] = useState(readDemoLoginSession)

  const startDemo = useCallback(() => {
    if (startDemoLoginSession()) setDemoActive(true)
  }, [])
  const leaveDemo = useCallback(() => setDemoActive(false), [])

  useEffect(() => {
    let mounted = true
    void isNativeTestAccessEnabled().then((enabled) => {
      if (mounted) setTestAccess(enabled)
    })
    return () => {
      mounted = false
    }
  }, [])

  if (testAccess === null) {
    return (
      <AuthContext.Provider value={checkingNativeAccessValue}>
        {children}
      </AuthContext.Provider>
    )
  }

  if (demoActive) {
    return (
      <DemoLoginAuthProvider onSignOut={leaveDemo}>
        {children}
      </DemoLoginAuthProvider>
    )
  }

  if (testAccess) {
    return (
      <DevelopmentPreviewAuthProvider autoStart testAccess>
        {children}
      </DevelopmentPreviewAuthProvider>
    )
  }

  if (!clerkConfigured) {
    return (
      <DevelopmentPreviewAuthProvider
        startDemo={demoLoginAvailable ? startDemo : undefined}
      >
        {children}
      </DevelopmentPreviewAuthProvider>
    )
  }

  return (
    <ClerkAuthBridge
      startDevelopmentPreview={demoLoginAvailable ? startDemo : undefined}
    >
      {children}
    </ClerkAuthBridge>
  )
}

export function ClerkAuthBridge({
  children,
  startDevelopmentPreview,
}: PropsWithChildren<{ startDevelopmentPreview?: () => void }>) {
  const {
    getToken: getClerkToken,
    isLoaded,
    isSignedIn,
    sessionId,
  } = useClerkAuth()
  const { user } = useUser()
  const { signOut: clerkSignOut } = useClerk()
  const [connectedSession, setConnectedSession] = useState<string | null>(null)
  const previousSignedInSessionRef = useRef<string | null>(null)

  const getToken = useCallback(
    (options?: { template?: string }) => getClerkToken(options),
    [getClerkToken],
  )
  const signOut = useCallback(async () => {
    await cancelActiveSubjectFlightNotifications()
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
    if (expectedSession) {
      previousSignedInSessionRef.current = expectedSession
      return
    }
    if (!isLoaded || isSignedIn || !previousSignedInSessionRef.current) return
    previousSignedInSessionRef.current = null
    void cancelActiveSubjectFlightNotifications()
  }, [expectedSession, isLoaded, isSignedIn])

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
      return {
        status: 'loading',
        user: null,
        getToken,
        signOut,
        startDevelopmentPreview,
      }
    }

    if (!isSignedIn || !authUser) {
      return {
        status: 'signed-out',
        user: null,
        getToken,
        signOut,
        startDevelopmentPreview,
      }
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
    startDevelopmentPreview,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function AuthProvider({
  children,
  value,
}: PropsWithChildren<{ value?: AuthContextValue }>) {
  if (value) {
    return <ProvidedAuthProvider value={value}>{children}</ProvidedAuthProvider>
  }

  return <RuntimeAuthProvider>{children}</RuntimeAuthProvider>
}

function ProvidedAuthProvider({
  children,
  value,
}: PropsWithChildren<{ value: AuthContextValue }>) {
  const signOut = useCallback(async () => {
    await cancelActiveSubjectFlightNotifications()
    await value.signOut()
  }, [value])
  const safeValue = useMemo(
    () => ({ ...value, signOut }),
    [signOut, value],
  )
  return <AuthContext.Provider value={safeValue}>{children}</AuthContext.Provider>
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
