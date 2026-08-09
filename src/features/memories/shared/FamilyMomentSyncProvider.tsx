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
  deleteFamilyMoment,
  fetchFamilyMomentDeletionIds,
  fetchFamilyMoments,
  getFamilyDailyCaptureWindow,
  getFamilyMomentConnection,
  publishFamilyMoment,
  resumePendingFamilyMomentDeletions,
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
  const { moments, removeMoments, saveMoment } = useSharedMoments()
  const [status, setStatus] = useState<FamilySyncStatus>('checking')
  const [dailyWindow, setDailyWindow] =
    useState<FamilyDailyCaptureWindow | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const connectionRef = useRef<FamilyMomentConnection | null>(null)
  const momentIdsRef = useRef(new Set<string>())
  const momentsRef = useRef(moments)
  const deletedIdsRef = useRef(new Set<string>())
  const refreshRequestedRef = useRef(false)
  const refreshRunRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    momentsRef.current = moments
    momentIdsRef.current = new Set(moments.map(({ id }) => id))
  }, [moments])

  useEffect(() => {
    if (status !== 'local') return

    const legacyLocalMoment = moments.find(
      (moment) =>
        moment.uploaderDisplayName === 'You' &&
        moment.ownedByCurrentUser === undefined &&
        moment.familySynced === undefined,
    )
    if (!legacyLocalMoment) return

    // Builds before ownership metadata existed saved device captures as
    // "You" only. Backfill them exclusively while there is no family
    // connection, so this migration can enable local removal but can never
    // authorize a server-side family deletion.
    const annotations = (legacyLocalMoment.annotations ?? []).map(
      ({ audioUrl: _audioUrl, ...annotation }) => annotation,
    )
    void saveMoment({
      id: legacyLocalMoment.id,
      blob: legacyLocalMoment.blob,
      label: legacyLocalMoment.label,
      caption: legacyLocalMoment.caption,
      createdAt: legacyLocalMoment.createdAt,
      width: legacyLocalMoment.width,
      height: legacyLocalMoment.height,
      source: legacyLocalMoment.source,
      uploaderDisplayName: legacyLocalMoment.uploaderDisplayName,
      ownedByCurrentUser: true,
      familySynced: false,
      annotations,
    }).catch((reason) => {
      setError(
        reason instanceof Error
          ? reason
          : new Error('An older device moment could not be updated.'),
      )
    })
  }, [moments, saveMoment, status])

  const performFamilyMomentRefresh = useCallback(async (
    connection: FamilyMomentConnection,
  ) => {
    try {
      // Fetch media first, then query durable tombstones for every cached or
      // fetched ID. Realtime also pre-marks deletions that happen mid-download.
      const incoming = await fetchFamilyMoments(connection)
      const deletionIds = await fetchFamilyMomentDeletionIds(connection, [
        ...momentsRef.current.map(({ id }) => id),
        ...incoming.flatMap(({ id }) => (id ? [id] : [])),
      ])
      if (connectionRef.current !== connection) return

      deletionIds.forEach((id) => deletedIdsRef.current.add(id))
      if (deletionIds.length > 0) {
        await removeMoments(deletionIds)
        deletionIds.forEach((id) => momentIdsRef.current.delete(id))
      }

      for (const moment of incoming) {
        if (
          !moment.id ||
          deletedIdsRef.current.has(moment.id) ||
          connectionRef.current !== connection
        ) {
          continue
        }
        const existing = moment.id
          ? momentsRef.current.find(({ id }) => id === moment.id)
          : undefined
        if (
          existing?.familySynced === true &&
          existing.ownedByCurrentUser === moment.ownedByCurrentUser
        ) {
          continue
        }
        const saved = await saveMoment(moment)
        if (
          deletedIdsRef.current.has(saved.id) ||
          connectionRef.current !== connection
        ) {
          await removeMoments([saved.id])
          momentIdsRef.current.delete(saved.id)
          continue
        }
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
  }, [removeMoments, saveMoment])

  const refreshFamilyMoments = useCallback(async () => {
    refreshRequestedRef.current = true
    if (refreshRunRef.current) return refreshRunRef.current

    const run = (async () => {
      while (refreshRequestedRef.current) {
        refreshRequestedRef.current = false
        const connection = connectionRef.current
        if (connection) await performFamilyMomentRefresh(connection)
      }
    })()
    refreshRunRef.current = run

    try {
      await run
    } finally {
      if (refreshRunRef.current === run) refreshRunRef.current = null
    }
  }, [performFamilyMomentRefresh])

  useEffect(() => {
    let active = true
    let connectionVersion = 0
    let familySubscription: FamilyMomentSubscription | null = null

    async function connect() {
      const requestedConnection = ++connectionVersion
      let requestedSubscription: FamilyMomentSubscription | null = null
      const releaseRequestedSubscription = () => {
        requestedSubscription?.unsubscribe()
        if (familySubscription === requestedSubscription) {
          familySubscription = null
        }
      }
      setStatus('checking')
      try {
        const connection = await getFamilyMomentConnection()
        if (!active || requestedConnection !== connectionVersion) return
        connectionRef.current = connection

        if (!connection) {
          deletedIdsRef.current.clear()
          setDailyWindow(null)
          setStatus('local')
          setError(null)
          return
        }

        try {
          await resumePendingFamilyMomentDeletions(connection)
        } catch {
          // The durable deleting row remains resumable on the next launch,
          // focus, or auth reconnect; it must not block receiving family posts.
        }
        if (!active || requestedConnection !== connectionVersion) return

        requestedSubscription = subscribeToFamilyMoments(
          connection.circleId,
          (deletedMomentId) => {
            if (deletedMomentId) {
              deletedIdsRef.current.add(deletedMomentId)
              momentIdsRef.current.delete(deletedMomentId)
              void removeMoments([deletedMomentId])
            }
            void refreshFamilyMoments()
          },
        )
        familySubscription = requestedSubscription
        await requestedSubscription.ready
        if (!active || requestedConnection !== connectionVersion) {
          releaseRequestedSubscription()
          return
        }

        const window = await getFamilyDailyCaptureWindow(connection)
        if (!active || requestedConnection !== connectionVersion) {
          releaseRequestedSubscription()
          return
        }
        setDailyWindow(window)
        setStatus('connected')
        setError(null)
        await refreshFamilyMoments()
      } catch (reason) {
        if (!active || requestedConnection !== connectionVersion) {
          releaseRequestedSubscription()
          return
        }
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
      refreshRequestedRef.current = false
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
      connectionRef.current = null
      refreshRequestedRef.current = false
      unsubscribeFromAuth()
      window.removeEventListener('kinsphere:family-sync-refresh', reconnect)
      window.removeEventListener('focus', reconnect)
      document.removeEventListener('visibilitychange', reconnectWhenVisible)
    }
  }, [refreshFamilyMoments, removeMoments])

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
          ownedByCurrentUser: true,
          familySynced: false,
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
        ownedByCurrentUser: true,
        familySynced: true,
        annotations,
      })
      return { delivery: 'family' }
    },
    [saveMoment],
  )

  const deleteMoment = useCallback(
    async (momentId: string) => {
      const moment = momentsRef.current.find(({ id }) => id === momentId)
      if (!moment?.ownedByCurrentUser) {
        throw new Error('Only the person who shared this moment can remove it.')
      }

      if (moment.familySynced) {
        const connection = connectionRef.current
        if (!connection) {
          throw new Error(
            'Reconnect to your family before removing this moment for everyone.',
          )
        }
        await deleteFamilyMoment(connection, momentId)
      }

      await removeMoments([momentId])
      momentIdsRef.current.delete(momentId)
    },
    [removeMoments],
  )

  const value = useMemo<FamilyMomentSyncContextValue>(
    () => ({
      status,
      dailyWindow,
      error,
      shareMoment,
      deleteMoment,
      refreshFamilyMoments,
    }),
    [dailyWindow, deleteMoment, error, refreshFamilyMoments, shareMoment, status],
  )

  return (
    <FamilyMomentSyncContext.Provider value={value}>
      {children}
    </FamilyMomentSyncContext.Provider>
  )
}
