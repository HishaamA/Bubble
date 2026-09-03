import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import { useAuth } from '../auth'
import {
  FamilyOnboardingContext,
  type FamilyOnboardingStatus,
} from './familyOnboardingContext'
import { toFamilyOnboardingMessage } from './familyOnboardingErrors'
import { defaultFamilyOnboardingAdapter } from './localFamilyOnboardingAdapter'
import type {
  FamilyAccessActor,
  FamilyAccessSnapshot,
  FamilyOnboardingAdapter,
} from './types'

// Family mutations dispatch this browser-level event so separately mounted
// providers can revalidate without sharing implementation details.
const FAMILY_SYNC_REFRESH_EVENT = 'kinsphere:family-sync-refresh'

/** Collapses backend access variants into the route-gate lifecycle states. */
function getStatusForSnapshot(
  snapshot: FamilyAccessSnapshot,
): FamilyOnboardingStatus {
  if (snapshot.kind === 'member') return 'member'
  if (snapshot.kind === 'pending') return 'pending'
  return 'needs-family'
}

/**
 * Resolves family membership for the authenticated user and rejects stale
 * asynchronous results when accounts or requests change.
 */
export function FamilyOnboardingProvider({
  children,
  adapter = defaultFamilyOnboardingAdapter,
}: PropsWithChildren<{ adapter?: FamilyOnboardingAdapter }>) {
  const { getToken, status: authStatus, user } = useAuth()
  const requestVersionRef = useRef(0)
  const currentStatusRef = useRef<FamilyOnboardingStatus>('idle')
  const resolvedUserIdRef = useRef<string | null>(null)
  const [snapshot, setSnapshot] = useState<FamilyAccessSnapshot | null>(null)
  const [familyStatus, setFamilyStatusState] =
    useState<FamilyOnboardingStatus>('idle')
  const [resolvedUserId, setResolvedUserId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  // Refs mirror state used inside async callbacks before React has rendered the
  // corresponding update; they are not an additional source of truth.
  const setFamilyStatus = useCallback((nextStatus: FamilyOnboardingStatus) => {
    currentStatusRef.current = nextStatus
    setFamilyStatusState(nextStatus)
  }, [])
  /** Moves the resolved-account marker in state and async-visible ref together. */
  const setResolvedUser = useCallback((nextUserId: string | null) => {
    resolvedUserIdRef.current = nextUserId
    setResolvedUserId(nextUserId)
  }, [])

  // Every refresh owns a version number so a slower request from the previous
  // account cannot replace membership for the current account.
  const refreshAccess = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current
    if (authStatus !== 'signed-in' || !user) {
      setSnapshot(null)
      setFamilyStatus('idle')
      setResolvedUser(null)
      setRefreshing(false)
      setErrorMessage('')
      return
    }
    if (!adapter.configured) {
      setSnapshot(null)
      setFamilyStatus('unavailable')
      setResolvedUser(user.id)
      setRefreshing(false)
      setErrorMessage('Family membership is not connected for this build.')
      return
    }

    const requiresBlockingLoad = resolvedUserIdRef.current !== user.id
    const preserveMemberSnapshot =
      !requiresBlockingLoad && currentStatusRef.current === 'member'
    if (requiresBlockingLoad) setFamilyStatus('loading')
    setRefreshing(true)
    setErrorMessage('')
    try {
      const nextSnapshot = await adapter.loadAccess({
        userId: user.id,
        getToken,
      })
      if (requestVersion !== requestVersionRef.current) return
      setSnapshot(nextSnapshot)
      setFamilyStatus(getStatusForSnapshot(nextSnapshot))
      setResolvedUser(user.id)
    } catch (errorReason) {
      if (requestVersion !== requestVersionRef.current) return
      if (preserveMemberSnapshot) {
        setErrorMessage(toFamilyOnboardingMessage(errorReason))
        return
      }
      setSnapshot(null)
      setFamilyStatus('error')
      setResolvedUser(user.id)
      setErrorMessage(toFamilyOnboardingMessage(errorReason))
    } finally {
      if (requestVersion === requestVersionRef.current) setRefreshing(false)
    }
  }, [adapter, authStatus, getToken, setFamilyStatus, setResolvedUser, user])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refreshAccess(), 0)
    return () => {
      window.clearTimeout(initialLoad)
      requestVersionRef.current += 1
    }
  }, [refreshAccess])

  useEffect(() => {
    if (authStatus !== 'signed-in') return

    /** Requests a non-blocking snapshot refresh from browser lifecycle events. */
    const revalidate = () => void refreshAccess()
    /** Refreshes only when returning to a visible document. */
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
  }, [authStatus, refreshAccess])

  // Creation and joining share the same identity checks and stale-response
  // guard, but receive their concrete persistence operation from the caller.
  const runOnboardingMutation = useCallback(
    async (
      operation: (actor: FamilyAccessActor) => Promise<FamilyAccessSnapshot>,
    ) => {
      if (!user || authStatus !== 'signed-in') {
        throw new Error('Sign in before setting up a family.')
      }
      if (!adapter.configured) {
        throw new Error('Family membership is not connected for this build.')
      }

      const requestVersion = ++requestVersionRef.current
      setFamilyStatus('loading')
      setRefreshing(false)
      setErrorMessage('')
      try {
        const nextSnapshot = await operation({ userId: user.id, getToken })
        if (requestVersion !== requestVersionRef.current) return null
        setSnapshot(nextSnapshot)
        setFamilyStatus(getStatusForSnapshot(nextSnapshot))
        setResolvedUser(user.id)
        return nextSnapshot
      } catch (errorReason) {
        if (requestVersion !== requestVersionRef.current) return null
        const safeErrorMessage = toFamilyOnboardingMessage(errorReason)
        setFamilyStatus('needs-family')
        setErrorMessage(safeErrorMessage)
        throw errorReason
      }
    },
    [adapter, authStatus, getToken, setFamilyStatus, setResolvedUser, user],
  )

  /** Binds family creation to the provider's guarded mutation lifecycle. */
  const createFamily = useCallback(
    (familyName: string) =>
      runOnboardingMutation((actor) =>
        adapter.createFamily(actor, familyName),
      ),
    [adapter, runOnboardingMutation],
  )
  /** Binds code-based joining to the provider's guarded mutation lifecycle. */
  const joinFamily = useCallback(
    (inviteCode: string) =>
      runOnboardingMutation((actor) =>
        adapter.joinFamily(actor, inviteCode),
      ),
    [adapter, runOnboardingMutation],
  )
  const contextValue = useMemo(
    () => ({
      status:
        authStatus === 'signed-in' && user?.id !== resolvedUserId
          ? ('loading' as const)
          : familyStatus,
      snapshot,
      error: errorMessage,
      refreshing,
      refresh: refreshAccess,
      createFamily,
      joinFamily,
    }),
    [
      authStatus,
      createFamily,
      errorMessage,
      familyStatus,
      joinFamily,
      refreshAccess,
      refreshing,
      resolvedUserId,
      snapshot,
      user?.id,
    ],
  )

  return (
    <FamilyOnboardingContext.Provider value={contextValue}>
      {children}
    </FamilyOnboardingContext.Provider>
  )
}

export type { FamilyOnboardingStatus } from './familyOnboardingContext'
