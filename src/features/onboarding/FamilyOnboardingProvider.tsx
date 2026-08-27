import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import { useAuth } from '../auth'
import { defaultFamilyOnboardingAdapter } from './localFamilyOnboardingAdapter'
import type {
  FamilyAccessSnapshot,
  FamilyOnboardingAdapter,
} from './types'

const FAMILY_SYNC_REFRESH_EVENT = 'kinsphere:family-sync-refresh'

export type FamilyOnboardingStatus =
  | 'idle'
  | 'loading'
  | 'needs-family'
  | 'pending'
  | 'member'
  | 'unavailable'
  | 'error'

type FamilyOnboardingContextValue = {
  status: FamilyOnboardingStatus
  snapshot: FamilyAccessSnapshot | null
  error: string
  refreshing: boolean
  refresh: () => Promise<void>
  createFamily: (
    familyName: string,
  ) => Promise<FamilyAccessSnapshot | null>
  joinFamily: (inviteCode: string) => Promise<FamilyAccessSnapshot | null>
}

const FamilyOnboardingContext =
  createContext<FamilyOnboardingContextValue | null>(null)

export function toFamilyOnboardingMessage(reason: unknown) {
  const raw =
    reason instanceof Error
      ? reason.message
      : reason && typeof reason === 'object' && 'message' in reason
        ? String(reason.message)
        : ''
  const code =
    reason && typeof reason === 'object' && 'code' in reason
      ? String(reason.code).toLowerCase()
      : ''
  const message = raw.toLowerCase()

  if (
    message.includes('invalid_invite_code') ||
    message.includes('invalid_family_code') ||
    message.includes('family_code_not_found')
  ) {
    return 'That family code is not valid.'
  }
  if (message.includes('invite_not_available')) {
    return 'That family code has expired, was revoked, or was already used.'
  }
  if (message.includes('already_a_member')) {
    return 'You are already connected to a family.'
  }
  if (message.includes('join_request_not_pending')) {
    return 'That request has already been handled. Check again for the latest status.'
  }
  if (
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('offline')
  ) {
    return 'Bubble could not reach your family space. Check your connection and try again.'
  }
  if (
    code === '42501' ||
    message.includes('permission') ||
    message.includes('row-level security')
  ) {
    return 'Your family access may have changed. Sign in again or ask the family owner.'
  }
  if (
    message.includes('jwt') ||
    message.includes('session') ||
    message.includes('sign in')
  ) {
    return 'Your secure session needs to be renewed. Sign in again to continue.'
  }

  return 'Family setup could not be completed. Please try again.'
}

function statusFor(snapshot: FamilyAccessSnapshot): FamilyOnboardingStatus {
  if (snapshot.kind === 'member') return 'member'
  if (snapshot.kind === 'pending') return 'pending'
  return 'needs-family'
}

export function FamilyOnboardingProvider({
  children,
  adapter = defaultFamilyOnboardingAdapter,
}: PropsWithChildren<{ adapter?: FamilyOnboardingAdapter }>) {
  const { getToken, status: authStatus, user } = useAuth()
  const requestVersion = useRef(0)
  const statusRef = useRef<FamilyOnboardingStatus>('idle')
  const resolvedUserIdRef = useRef<string | null>(null)
  const [snapshot, setSnapshot] = useState<FamilyAccessSnapshot | null>(null)
  const [status, setStatus] = useState<FamilyOnboardingStatus>('idle')
  const [resolvedUserId, setResolvedUserId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const updateStatus = useCallback((next: FamilyOnboardingStatus) => {
    statusRef.current = next
    setStatus(next)
  }, [])
  const resolveUser = useCallback((userId: string | null) => {
    resolvedUserIdRef.current = userId
    setResolvedUserId(userId)
  }, [])

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current
    if (authStatus !== 'signed-in' || !user) {
      setSnapshot(null)
      updateStatus('idle')
      resolveUser(null)
      setRefreshing(false)
      setError('')
      return
    }
    if (!adapter.configured) {
      setSnapshot(null)
      updateStatus('unavailable')
      resolveUser(user.id)
      setRefreshing(false)
      setError('Family membership is not connected for this build.')
      return
    }

    const blocking = resolvedUserIdRef.current !== user.id
    const preserveMember = !blocking && statusRef.current === 'member'
    if (blocking) updateStatus('loading')
    setRefreshing(true)
    setError('')
    try {
      const next = await adapter.loadAccess({ userId: user.id, getToken })
      if (version !== requestVersion.current) return
      setSnapshot(next)
      updateStatus(statusFor(next))
      resolveUser(user.id)
    } catch (reason) {
      if (version !== requestVersion.current) return
      if (preserveMember) {
        setError(toFamilyOnboardingMessage(reason))
        return
      }
      setSnapshot(null)
      updateStatus('error')
      resolveUser(user.id)
      setError(toFamilyOnboardingMessage(reason))
    } finally {
      if (version === requestVersion.current) setRefreshing(false)
    }
  }, [adapter, authStatus, getToken, resolveUser, updateStatus, user])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refresh(), 0)
    return () => {
      window.clearTimeout(initialLoad)
      requestVersion.current += 1
    }
  }, [refresh])

  useEffect(() => {
    if (authStatus !== 'signed-in') return

    const revalidate = () => void refresh()
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') revalidate()
    }
    window.addEventListener('focus', revalidate)
    window.addEventListener(FAMILY_SYNC_REFRESH_EVENT, revalidate)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('focus', revalidate)
      window.removeEventListener(FAMILY_SYNC_REFRESH_EVENT, revalidate)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [authStatus, refresh])

  const run = useCallback(
    async (
      operation: (
        actor: { userId: string; getToken: typeof getToken },
      ) => Promise<FamilyAccessSnapshot>,
    ) => {
      if (!user || authStatus !== 'signed-in') {
        throw new Error('Sign in before setting up a family.')
      }
      if (!adapter.configured) {
        throw new Error('Family membership is not connected for this build.')
      }

      const version = ++requestVersion.current
      updateStatus('loading')
      setRefreshing(false)
      setError('')
      try {
        const next = await operation({ userId: user.id, getToken })
        if (version !== requestVersion.current) return null
        setSnapshot(next)
        updateStatus(statusFor(next))
        resolveUser(user.id)
        return next
      } catch (reason) {
        if (version !== requestVersion.current) return null
        const message = toFamilyOnboardingMessage(reason)
        updateStatus('needs-family')
        setError(message)
        throw reason
      }
    },
    [adapter, authStatus, getToken, resolveUser, updateStatus, user],
  )

  const createFamily = useCallback(
    (familyName: string) =>
      run((actor) => adapter.createFamily(actor, familyName)),
    [adapter, run],
  )
  const joinFamily = useCallback(
    (inviteCode: string) =>
      run((actor) => adapter.joinFamily(actor, inviteCode)),
    [adapter, run],
  )
  const value = useMemo(
    () => ({
      status:
        authStatus === 'signed-in' && user?.id !== resolvedUserId
          ? ('loading' as const)
          : status,
      snapshot,
      error,
      refreshing,
      refresh,
      createFamily,
      joinFamily,
    }),
    [
      authStatus,
      createFamily,
      error,
      joinFamily,
      refresh,
      refreshing,
      resolvedUserId,
      snapshot,
      status,
      user?.id,
    ],
  )

  return (
    <FamilyOnboardingContext.Provider value={value}>
      {children}
    </FamilyOnboardingContext.Provider>
  )
}

export function useFamilyOnboarding() {
  const context = useContext(FamilyOnboardingContext)
  if (!context) {
    throw new Error(
      'useFamilyOnboarding must be used inside FamilyOnboardingProvider.',
    )
  }
  return context
}
