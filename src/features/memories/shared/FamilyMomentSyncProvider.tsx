import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import type { Capture360Submission } from '../../capture'
import { withAiPanoramaDisclosure } from '../../../services/media/panoramaProvenance'
import { subscribeToSupabaseAuthChanges } from '../../../lib/supabase'
import { subscribeToAppResume } from '../../../lib/appResume'
import {
  deleteFamilyMoment,
  fetchFamilyMomentDeletionIds,
  fetchFamilyMoments,
  getFamilyDailyCaptureWindow,
  getFamilyMomentConnection,
  publishFamilyMoment,
  replaceFamilyMomentAnnotations,
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
import type {
  StoredPanoramaAnnotation,
  StoredPanoramaMoment,
} from './types'

/** Confirms that every voice annotation still has restart-safe Blob media. */
function annotationsAreDurablyCached(
  existing: StoredPanoramaMoment,
  incoming: Pick<StoredPanoramaMoment, 'annotations'>,
) {
  const existingAnnotations = existing.annotations ?? []
  const incomingAnnotations = incoming.annotations ?? []
  if (existingAnnotations.length !== incomingAnnotations.length) return false

  return incomingAnnotations.every((incomingAnnotation) => {
    const cached = existingAnnotations.find(
      ({ id }) => id === incomingAnnotation.id,
    )
    if (!cached || !annotationMetadataMatches(cached, incomingAnnotation)) {
      return false
    }

    // A failed private-storage download leaves the annotation metadata in the
    // cache without its Blob. Do not treat that record as complete: the next
    // refresh must try the voice object again instead of skipping forever.
    return cached.kind !== 'voice' || cached.audioBlob instanceof Blob
  })
}

/** Compares server-visible annotation fields while ignoring local playback URLs. */
function annotationMetadataMatches(
  cached: StoredPanoramaAnnotation,
  incoming: StoredPanoramaAnnotation,
) {
  return (
    cached.kind === incoming.kind &&
    cached.pitch === incoming.pitch &&
    cached.yaw === incoming.yaw &&
    cached.message === incoming.message &&
    cached.audioMimeType === incoming.audioMimeType &&
    cached.durationMs === incoming.durationMs
  )
}

/** Detects a remote refresh that would replace durable local audio with metadata. */
function incomingMomentWouldDiscardCachedVoice(
  existing: StoredPanoramaMoment,
  incoming: Pick<StoredPanoramaMoment, 'annotations'>,
) {
  const existingAnnotations = existing.annotations ?? []
  return (incoming.annotations ?? []).some((incomingAnnotation) => {
    if (
      incomingAnnotation.kind !== 'voice' ||
      incomingAnnotation.audioBlob instanceof Blob
    ) {
      return false
    }
    return existingAnnotations.some(
      (cached) =>
        cached.id === incomingAnnotation.id &&
        cached.kind === 'voice' &&
        cached.audioBlob instanceof Blob,
    )
  })
}

/**
 * Reconciles the local panorama cache with the signed-in family's backend.
 * Durable deletion markers and serialized refreshes prevent stale downloads
 * from resurrecting a moment that another device removed mid-sync.
 */
export function FamilyMomentSyncProvider({ children }: PropsWithChildren) {
  const {
    loading: momentsLoading,
    moments,
    removeMoments,
    saveMoment,
  } = useSharedMoments()
  const [cacheHydrated, setCacheHydrated] = useState(false)
  const [status, setStatus] = useState<FamilySyncStatus>('checking')
  const [dailyWindow, setDailyWindow] =
    useState<FamilyDailyCaptureWindow | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const connectionRef = useRef<FamilyMomentConnection | null>(null)
  const momentsRef = useRef(moments)
  const deletedIdsRef = useRef(new Set<string>())
  const refreshRequestedRef = useRef(false)
  const refreshRunRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    if (!momentsLoading) {
      // This is a one-way readiness latch. Later save/refresh operations may
      // temporarily set loading again but must not tear down family realtime.
      // oxlint-disable-next-line react/set-state-in-effect -- IndexedDB hydration is an external readiness signal.
      setCacheHydrated(true)
    }
  }, [momentsLoading])

  useEffect(() => {
    momentsRef.current = moments
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
      provenance: legacyLocalMoment.provenance,
      captureSessionId: legacyLocalMoment.captureSessionId,
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

  /** Reconciles remote moments and deletion tombstones into the durable local cache. */
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
        // The current backend stores the disclosure caption, not provider metadata.
        // Preserve explicit local provenance during remote annotation/ownership refreshes.
        const provenance = moment.provenance ?? existing?.provenance
        const reconciled = {
          ...moment,
          ...(provenance ? { provenance } : {}),
          ...(existing?.captureSessionId ? { captureSessionId: existing.captureSessionId } : {}),
          caption: withAiPanoramaDisclosure(moment.caption, provenance),
          annotations: (moment.annotations ?? []).map((annotation) => {
            const cached = existing?.annotations?.find(({ id }) => id === annotation.id)
            return annotation.kind === 'voice' && !annotation.audioBlob && cached?.audioBlob &&
              annotationMetadataMatches(cached, annotation)
              ? { ...annotation, audioBlob: cached.audioBlob }
              : annotation
          }),
        }
        if (
          existing?.familySynced === true &&
          existing.ownedByCurrentUser === moment.ownedByCurrentUser &&
          existing.caption === reconciled.caption &&
          (
            annotationsAreDurablyCached(existing, moment) ||
            // Storage may return annotation metadata while a private voice
            // object temporarily fails to download. Keep the known-good Blob;
            // fetchFamilyMoments will attempt the remote object again on the
            // next refresh instead of degrading the local cache.
            incomingMomentWouldDiscardCachedVoice(existing, moment)
          )
        ) {
          continue
        }
        const saved = await saveMoment(reconciled)
        if (
          deletedIdsRef.current.has(saved.id) ||
          connectionRef.current !== connection
        ) {
          await removeMoments([saved.id])
          continue
        }
      }
      if (connectionRef.current === connection) setError(null)
    } catch (reason) {
      if (connectionRef.current !== connection) return
      setError(
        reason instanceof Error
          ? reason
          : new Error('Family moments could not be refreshed.'),
      )
    }
  }, [removeMoments, saveMoment])

  /** Coalesces refresh requests while guaranteeing one final pass after changes. */
  const refreshFamilyMoments = useCallback(async () => {
    refreshRequestedRef.current = true
    if (refreshRunRef.current) return refreshRunRef.current

    /** Drains refresh demand without allowing concurrent reconciliation passes. */
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
    if (!cacheHydrated) return

    let active = true
    let connectionVersion = 0
    let familySubscription: FamilyMomentSubscription | null = null

    // Establishes one versioned sync session so stale asynchronous work cannot
    // replace a newer account or family connection.
    /** Establishes the current identity's connection, subscription, and daily window. */
    async function connect() {
      const requestedConnection = ++connectionVersion
      let requestedSubscription: FamilyMomentSubscription | null = null
      let initialRefreshStarted = false
      /** Releases only the subscription created by this connection attempt. */
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

        try {
          requestedSubscription = subscribeToFamilyMoments(
            connection.circleId,
            (deletedMomentId) => {
              if (!active || requestedConnection !== connectionVersion) return
              if (deletedMomentId) {
                deletedIdsRef.current.add(deletedMomentId)
                void removeMoments([deletedMomentId])
              }
              void refreshFamilyMoments()
            },
          )
          familySubscription = requestedSubscription
          // Load the common family space immediately. Realtime is an update
          // transport, not permission to read: a blocked websocket must never
          // hide everyone else's moments. Refresh again on readiness to close
          // the initial-fetch/subscription gap without losing intervening posts.
          void requestedSubscription.ready.then(() => {
            if (active && requestedConnection === connectionVersion && initialRefreshStarted) {
              void refreshFamilyMoments()
            }
          }).catch(() => {
            releaseRequestedSubscription()
          })
        } catch {
          // A failed live channel still leaves authenticated reads/publishing
          // available; resume and explicit refresh retry the connection later.
        }

        // The scheduled-camera window is independent of the shared gallery.
        // A temporary window-service failure must not hide existing panoramas.
        void getFamilyDailyCaptureWindow(connection).then((captureWindow) => {
          if (active && requestedConnection === connectionVersion) {
            setDailyWindow(captureWindow)
          }
        }).catch(() => {
          if (active && requestedConnection === connectionVersion) setDailyWindow(null)
        })
        setStatus('connected')
        setError(null)
        // Give an already-connected channel its readiness microtask before
        // starting the first read, avoiding duplicate panorama downloads in
        // the common case. A later readiness signal still triggers the gap read.
        await Promise.resolve()
        if (!active || requestedConnection !== connectionVersion) return
        initialRefreshStarted = true
        await refreshFamilyMoments()
      } catch (reason) {
        if (!active || requestedConnection !== connectionVersion) {
          releaseRequestedSubscription()
          return
        }
        releaseRequestedSubscription()
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

    // Invalidates the current session before starting a fresh connection.
    /** Invalidates active family state before resolving a fresh identity/session. */
    function reconnect() {
      familySubscription?.unsubscribe()
      familySubscription = null
      connectionRef.current = null
      setDailyWindow(null)
      refreshRequestedRef.current = false
      void connect()
    }

    void connect()
    const unsubscribeFromAuth = subscribeToSupabaseAuthChanges(reconnect)
    const stopResume = subscribeToAppResume(reconnect)
    window.addEventListener('kinsphere:family-sync-refresh', reconnect)

    return () => {
      active = false
      connectionVersion += 1
      familySubscription?.unsubscribe()
      familySubscription = null
      connectionRef.current = null
      refreshRequestedRef.current = false
      unsubscribeFromAuth()
      stopResume()
      window.removeEventListener('kinsphere:family-sync-refresh', reconnect)
    }
  }, [cacheHydrated, refreshFamilyMoments, removeMoments])

  /** Saves locally when offline, or publishes then caches the processed family copy. */
  const shareMoment = useCallback(
    async (
      submission: Capture360Submission,
    ): Promise<{ delivery: 'local' | 'family' }> => {
      const connection = connectionRef.current
      const annotations = submission.annotations ?? []
      const caption = withAiPanoramaDisclosure(submission.caption, submission.provenance)

      if (!connection) {
        await saveMoment({
          id: submission.id,
          blob: submission.file,
          label: caption || 'A new 360 moment',
          caption,
          provenance: submission.provenance,
          captureSessionId: submission.captureSessionId,
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

      const processed = await publishFamilyMoment(connection, { ...submission, caption })
      await saveMoment({
        id: submission.id,
        blob: processed.viewer,
        label: caption || 'A new 360 moment',
        caption,
        provenance: submission.provenance,
        captureSessionId: submission.captureSessionId,
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

  /** Enforces ownership and remote deletion before removing the local cache entry. */
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
    },
    [removeMoments],
  )

  /** Replaces owner-authored annotations remotely before updating the local copy. */
  const updateMomentAnnotations = useCallback(
    async (
      momentId: string,
      annotations: StoredPanoramaAnnotation[],
    ) => {
      const moment = momentsRef.current.find(({ id }) => id === momentId)
      if (!moment?.ownedByCurrentUser) {
        throw new Error('Only the person who shared this moment can edit its memory points.')
      }

      if (moment.familySynced) {
        const connection = connectionRef.current
        if (!connection) {
          throw new Error(
            'Reconnect to your family before editing this shared moment.',
          )
        }
        await replaceFamilyMomentAnnotations(connection, moment.id, annotations)
      }

      await saveMoment({
        id: moment.id,
        blob: moment.blob,
        label: moment.label,
        caption: moment.caption,
        createdAt: moment.createdAt,
        width: moment.width,
        height: moment.height,
        source: moment.source,
        provenance: moment.provenance,
        captureSessionId: moment.captureSessionId,
        uploaderDisplayName: moment.uploaderDisplayName,
        isDraft: moment.isDraft,
        ownedByCurrentUser: true,
        familySynced: moment.familySynced,
        annotations,
      })
    },
    [saveMoment],
  )

  const value = useMemo<FamilyMomentSyncContextValue>(
    () => ({
      status,
      dailyWindow,
      error,
      shareMoment,
      updateMomentAnnotations,
      deleteMoment,
      refreshFamilyMoments,
    }),
    [
      dailyWindow,
      deleteMoment,
      error,
      refreshFamilyMoments,
      shareMoment,
      status,
      updateMomentAnnotations,
    ],
  )

  return (
    <FamilyMomentSyncContext.Provider value={value}>
      {children}
    </FamilyMomentSyncContext.Provider>
  )
}
