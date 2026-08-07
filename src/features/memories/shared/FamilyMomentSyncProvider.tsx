import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import type { Capture360Submission } from '../../capture'
import { subscribeToSupabaseAuthChanges } from '../../../lib/supabase'
import {
  fetchFamilyMoments,
  getFamilyDailyCaptureWindow,
  getFamilyMomentConnection,
  publishFamilyMoment,
  subscribeToFamilyMoments,
  type FamilyDailyCaptureWindow,
  type FamilyMomentConnection,
  type FamilyMomentSubscription,
} from '../../../services/media/familyMomentService'
import { useSharedMoments } from './useSharedMoments'
import {
  FamilyMomentSyncContext,
  type FamilyMomentSyncContextValue,
  type FamilySyncStatus,
} from './useFamilyMomentSync'

export function FamilyMomentSyncProvider({ children }: PropsWithChildren) {
  const { moments, saveMoment } = useSharedMoments()
  const [status, setStatus] = useState<FamilySyncStatus>('checking')
  const [dailyWindow, setDailyWindow] =
    useState<FamilyDailyCaptureWindow | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const connectionRef = useRef<FamilyMomentConnection | null>(null)
  const momentIdsRef = useRef(new Set<string>())

  useEffect(() => {
    momentIdsRef.current = new Set(moments.map(({ id }) => id))
  }, [moments])

  const refreshFamilyMoments = useCallback(async () => {
    const connection = connectionRef.current
    if (!connection) return

    try {
      const incoming = await fetchFamilyMoments(connection)
      for (const moment of incoming) {
        if (moment.id && momentIdsRef.current.has(moment.id)) continue
        const saved = await saveMoment(moment)
        momentIdsRef.current.add(saved.id)
      }
      setError(null)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason
          : new Error('Family moments could not be refreshed.'),
      )
    }
  }, [saveMoment])

  useEffect(() => {
    let active = true
    let connectionVersion = 0
    let familySubscription: FamilyMomentSubscription | null = null

    async function connect() {
      const requestedConnection = ++connectionVersion
      let requestedSubscription: FamilyMomentSubscription | null = null
      setStatus('checking')
      try {
        const connection = await getFamilyMomentConnection()
        if (!active || requestedConnection !== connectionVersion) return
        connectionRef.current = connection

        if (!connection) {
          setDailyWindow(null)
          setStatus('local')
          setError(null)
          return
        }

        requestedSubscription = subscribeToFamilyMoments(
          connection.circleId,
          () => void refreshFamilyMoments(),
        )
        familySubscription = requestedSubscription
        await requestedSubscription.ready
        if (!active || requestedConnection !== connectionVersion) return

        const window = await getFamilyDailyCaptureWindow(connection)
        if (!active || requestedConnection !== connectionVersion) return
        setDailyWindow(window)
        setStatus('connected')
        setError(null)
        await refreshFamilyMoments()
      } catch (reason) {
        if (!active || requestedConnection !== connectionVersion) return
        if (familySubscription === requestedSubscription) {
          requestedSubscription?.unsubscribe()
          familySubscription = null
        }
        connectionRef.current = null
        setDailyWindow(null)
        setStatus('error')
        setError(
          reason instanceof Error
            ? reason
            : new Error('Secure family sync could not connect.'),
        )
      }
    }

    function reconnect() {
      familySubscription?.unsubscribe()
      familySubscription = null
      connectionRef.current = null
      void connect()
    }

    function reconnectWhenVisible() {
      if (document.visibilityState === 'visible') reconnect()
    }

    void connect()
    const unsubscribeFromAuth = subscribeToSupabaseAuthChanges(reconnect)
    window.addEventListener('kinsphere:family-sync-refresh', reconnect)
    window.addEventListener('focus', reconnect)
    document.addEventListener('visibilitychange', reconnectWhenVisible)

    return () => {
      active = false
      connectionVersion += 1
      familySubscription?.unsubscribe()
      familySubscription = null
      unsubscribeFromAuth()
      window.removeEventListener('kinsphere:family-sync-refresh', reconnect)
      window.removeEventListener('focus', reconnect)
      document.removeEventListener('visibilitychange', reconnectWhenVisible)
    }
  }, [refreshFamilyMoments])

  const shareMoment = useCallback(
    async (
      submission: Capture360Submission,
    ): Promise<{ delivery: 'local' | 'family' }> => {
      const connection = connectionRef.current
      const annotations = submission.annotations ?? []

      if (!connection) {
        await saveMoment({
          id: submission.id,
          blob: submission.file,
          label: submission.caption || 'A new 360 moment',
          caption: submission.caption,
          createdAt: submission.createdAt,
          width: submission.width,
          height: submission.height,
          source: submission.source,
          uploaderDisplayName: 'You',
          annotations,
        })
        return { delivery: 'local' }
      }

      const processed = await publishFamilyMoment(connection, submission)
      await saveMoment({
        id: submission.id,
        blob: processed.viewer,
        label: submission.caption || 'A new 360 moment',
        caption: submission.caption,
        createdAt: submission.createdAt,
        width: processed.viewerWidth,
        height: processed.viewerHeight,
        source: submission.source,
        uploaderDisplayName: 'You',
        annotations,
      })
      return { delivery: 'family' }
    },
    [saveMoment],
  )

  const value = useMemo<FamilyMomentSyncContextValue>(
    () => ({
      status,
      dailyWindow,
      error,
      shareMoment,
      refreshFamilyMoments,
    }),
    [dailyWindow, error, refreshFamilyMoments, shareMoment, status],
  )

  return (
    <FamilyMomentSyncContext.Provider value={value}>
      {children}
    </FamilyMomentSyncContext.Provider>
  )
}
