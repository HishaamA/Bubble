import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  SharedMomentsContext,
  type SharedMomentsContextValue,
  type SharedMomentsProviderProps,
} from './context'
import { createMomentChangeNotifier } from './notifier'
import { createDefaultMomentStore, preparePanoramaMoment } from './store'
import type {
  MomentChangeNotifier,
  MomentObjectUrlManager,
  PanoramaMoment,
  SavePanoramaMomentInput,
  StoredPanoramaMoment,
} from './types'

function createBrowserObjectUrlManager(): MomentObjectUrlManager {
  return {
    create(blob) {
      if (
        typeof window === 'undefined' ||
        typeof window.URL?.createObjectURL !== 'function'
      ) {
        return null
      }

      try {
        return window.URL.createObjectURL(blob)
      } catch {
        return null
      }
    },
    revoke(url) {
      if (
        typeof window !== 'undefined' &&
        typeof window.URL?.revokeObjectURL === 'function'
      ) {
        window.URL.revokeObjectURL(url)
      }
    },
  }
}

export function SharedMomentsProvider({
  children,
  store,
  cacheNamespace = 'local-preview',
  objectUrls,
  notifierFactory = createMomentChangeNotifier,
}: SharedMomentsProviderProps) {
  const defaultStore = useMemo(
    () => createDefaultMomentStore(cacheNamespace),
    [cacheNamespace],
  )
  const [defaultObjectUrls] = useState(createBrowserObjectUrlManager)
  const [createNotifier] = useState(() => notifierFactory)
  const activeStore = store ?? defaultStore
  const activeObjectUrls = objectUrls ?? defaultObjectUrls
  const [moments, setMoments] = useState<PanoramaMoment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const mountedRef = useRef(false)
  const requestRef = useRef(0)
  const liveUrlsRef = useRef<string[]>([])
  const notifierRef = useRef<MomentChangeNotifier | null>(null)

  const replaceMoments = useCallback(
    (records: StoredPanoramaMoment[]) => {
      const nextMoments = records.map((moment) => {
        const annotations = (moment.annotations ?? []).map((annotation) => ({
          ...annotation,
          audioUrl: annotation.audioBlob
            ? activeObjectUrls.create(annotation.audioBlob)
            : null,
        }))

        return {
          ...moment,
          objectUrl: activeObjectUrls.create(moment.blob),
          annotations,
        }
      })
      const previousUrls = liveUrlsRef.current
      liveUrlsRef.current = nextMoments.flatMap((moment) => [
        ...(moment.objectUrl ? [moment.objectUrl] : []),
        ...moment.annotations.flatMap((annotation) =>
          annotation.audioUrl ? [annotation.audioUrl] : [],
        ),
      ])
      setMoments(nextMoments)
      previousUrls.forEach((url) => activeObjectUrls.revoke(url))
    },
    [activeObjectUrls],
  )

  const loadRecords = useCallback(async () => {
    const request = ++requestRef.current

    try {
      const records = await activeStore.list()
      if (!mountedRef.current || request !== requestRef.current) return
      replaceMoments(records)
      setError(null)
    } catch (reason) {
      if (!mountedRef.current || request !== requestRef.current) return
      setError(
        reason instanceof Error
          ? reason
          : new Error('Could not load family moments'),
      )
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false)
    }
  }, [activeStore, replaceMoments])

  const refresh = useCallback(async () => {
    setLoading(true)
    await loadRecords()
  }, [loadRecords])

  useEffect(() => {
    mountedRef.current = true
    const notifier = createNotifier()
    notifierRef.current = notifier
    const unsubscribe = notifier.subscribe(() => void refresh())
    // oxlint-disable-next-line react/set-state-in-effect -- IndexedDB hydration is an external-system sync.
    void loadRecords()

    return () => {
      mountedRef.current = false
      requestRef.current += 1
      unsubscribe()
      notifier.close()
      if (notifierRef.current === notifier) notifierRef.current = null
      liveUrlsRef.current.forEach((url) => activeObjectUrls.revoke(url))
      liveUrlsRef.current = []
    }
  }, [activeObjectUrls, createNotifier, loadRecords, refresh])

  const saveMoment = useCallback(
    async (input: SavePanoramaMomentInput) => {
      const moment = preparePanoramaMoment(input)
      await activeStore.save(moment)
      await refresh()
      notifierRef.current?.publish()
      return moment
    },
    [activeStore, refresh],
  )

  const removeMoments = useCallback(
    async (ids: readonly string[]) => {
      const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
      if (uniqueIds.length === 0) return
      await activeStore.remove(uniqueIds)
      await refresh()
      notifierRef.current?.publish()
    },
    [activeStore, refresh],
  )

  const value = useMemo<SharedMomentsContextValue>(
    () => ({ loading, error, moments, saveMoment, removeMoments, refresh }),
    [error, loading, moments, refresh, removeMoments, saveMoment],
  )

  return (
    <SharedMomentsContext.Provider value={value}>
      {children}
    </SharedMomentsContext.Provider>
  )
}
