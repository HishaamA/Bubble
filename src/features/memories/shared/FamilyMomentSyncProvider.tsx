import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import type { Capture360Submission } from '../../capture'
import { supabase } from '../../../lib/supabase'
import {
  fetchFamilyMoments,
  getFamilyDailyCaptureWindow,
  getFamilyMomentConnection,
  publishFamilyMoment,
  subscribeToFamilyMoments,
  type FamilyDailyCaptureWindow,
  type FamilyMomentConnection,
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
    let unsubscribeFromMoments: () => void = () => undefined

    async function connect() {
      const requestedConnection = ++connectionVersion
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

        const window = await getFamilyDailyCaptureWindow(connection)
        if (!active || requestedConnection !== connectionVersion) return
        setDailyWindow(window)
        setStatus('connected')
        setError(null)
        await refreshFamilyMoments()
        if (!active || requestedConnection !== connectionVersion) return
        unsubscribeFromMoments = subscribeToFamilyMoments(
          connection.circleId,
          () => void refreshFamilyMoments(),
        )
      } catch (reason) {
        if (!active || requestedConnection !== connectionVersion) return
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
      unsubscribeFromMoments()
      unsubscribeFromMoments = () => undefined
      void connect()
    }

    function reconnectWhenVisible() {
      if (document.visibilityState === 'visible') reconnect()
    }

    void connect()
    const authSubscription = supabase?.auth.onAuthStateChange(reconnect)
    window.addEventListener('kinsphere:family-sync-refresh', reconnect)
    window.addEventListener('focus', reconnect)
    document.addEventListener('visibilitychange', reconnectWhenVisible)

    return () => {
      active = false
      connectionVersion += 1
      unsubscribeFromMoments()
      authSubscription?.data.subscription.unsubscribe()
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
