import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchFamilyCapsules,
  subscribeToFamilyCapsules,
} from '../capsules/capsuleService'
import type { FamilyCapsule } from '../capsules/types'
import {
  fetchFamilyEvents,
  subscribeToFamilyEvents,
  type FamilyEventRecord,
} from '../events/eventService'
import { decodePlanDetails } from '../events/planDetails'
import { useAppTheme } from '../../theme/AppTheme'
import {
  clearNativeBubbleWidget,
  isNativeBubbleWidgetAvailable,
  updateNativeBubbleWidget,
} from './nativeBubbleWidget'
import {
  selectBubbleWidgetTimeline,
  type WidgetEvent,
} from './widgetSnapshot'
import {
  BUBBLE_WIDGET_DATA_CHANGED_EVENT,
  readViewedWidgetRecaps,
  readWidgetChecklistProgress,
  readWidgetCompletedPlanIds,
  readWidgetLocalEvents,
  readWidgetPrivacy,
  readWidgetTaskDefinitions,
} from './widgetStorage'
import { materializeWidgetThumbnail } from './widgetThumbnail'

type WidgetData = {
  storageSubject: string
  events: FamilyEventRecord[]
  capsules: FamilyCapsule[]
  refreshedAt: Date
  localRevision: number
}

/** Keeps the native homescreen widget synchronized while a member is signed in. */
export function WidgetSnapshotPublisher({
  storageSubject,
}: {
  storageSubject: string
}) {
  const { theme } = useAppTheme()
  const [data, setData] = useState<WidgetData>(() => ({
    storageSubject,
    events: [],
    capsules: [],
    refreshedAt: new Date(),
    localRevision: 0,
  }))
  const publishQueueRef = useRef(Promise.resolve())
  const publishVersionRef = useRef(0)
  const lastPayloadRef = useRef('')
  const thumbnailCacheRef = useRef<{
    source: unknown
    dataUrl: string | undefined
  } | null>(null)

  useEffect(() => {
    if (!isNativeBubbleWidgetAvailable()) return
    let active = true
    let stopEvents: () => void = () => undefined
    let stopCapsules: () => void = () => undefined

    async function refresh() {
      const [events, capsules] = await Promise.allSettled([
        fetchFamilyEvents({ includeEarlierToday: true }),
        fetchFamilyCapsules(),
      ])
      if (!active) return
      setData((current) => ({
        storageSubject,
        events: events.status === 'fulfilled'
          ? events.value
          : current.storageSubject === storageSubject ? current.events : [],
        capsules: capsules.status === 'fulfilled'
          ? capsules.value
          : current.storageSubject === storageSubject ? current.capsules : [],
        refreshedAt: new Date(),
        localRevision: current.localRevision + 1,
      }))
    }

    function refreshWhenVisible() {
      if (document.visibilityState !== 'hidden') void refresh()
    }

    function republishFromMemoryThenRefresh() {
      if (!active) return
      // Privacy and local checklist changes must reach native storage without
      // waiting for either family-service request to settle.
      setData((current) => ({
        ...current,
        refreshedAt: new Date(),
        localRevision: current.localRevision + 1,
      }))
      void refresh()
    }

    void refresh()
    void subscribeToFamilyEvents(() => void refresh())
      .then((stop) => {
        if (active) stopEvents = stop
        else stop()
      })
      .catch(() => undefined)
    void subscribeToFamilyCapsules(() => void refresh())
      .then((stop) => {
        if (active) stopCapsules = stop
        else stop()
      })
      .catch(() => undefined)
    window.addEventListener('online', refresh)
    window.addEventListener('storage', refresh)
    window.addEventListener(
      BUBBLE_WIDGET_DATA_CHANGED_EVENT,
      republishFromMemoryThenRefresh,
    )
    document.addEventListener('visibilitychange', refreshWhenVisible)

    return () => {
      active = false
      publishVersionRef.current += 1
      stopEvents()
      stopCapsules()
      window.removeEventListener('online', refresh)
      window.removeEventListener('storage', refresh)
      window.removeEventListener(
        BUBBLE_WIDGET_DATA_CHANGED_EVENT,
        republishFromMemoryThenRefresh,
      )
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      lastPayloadRef.current = ''
      void clearNativeBubbleWidget().catch(() => undefined)
    }
  }, [storageSubject])

  const selection = useMemo(() => {
    const scopedData = data.storageSubject === storageSubject
      ? data
      : { ...data, events: [], capsules: [], refreshedAt: new Date() }
    const checklist = readWidgetChecklistProgress(storageSubject)
    const taskDefinitions = readWidgetTaskDefinitions(storageSubject)
    const completedPlans = readWidgetCompletedPlanIds(storageSubject)
    const eventsById = new Map<string, WidgetEvent>()

    scopedData.events.forEach((event) => {
      if (completedPlans.has(event.id)) return
      const encodedTasks = decodePlanDetails(event.details)?.tasks ?? []
      eventsById.set(event.id, {
        id: event.id,
        title: event.title,
        startsAt: event.startsAt,
        location: event.location,
        tasks: taskDefinitions[event.id] ?? encodedTasks,
        completedTaskIds: checklist[event.id] ?? [],
      })
    })
    readWidgetLocalEvents(storageSubject).forEach((event) => {
      if (completedPlans.has(event.id)) return
      eventsById.set(event.id, {
        ...event,
        tasks: taskDefinitions[event.id] ?? event.tasks,
        completedTaskIds: checklist[event.id] ?? [],
      })
    })

    return selectBubbleWidgetTimeline({
      now: scopedData.refreshedAt,
      theme,
      privacy: readWidgetPrivacy(storageSubject),
      events: [...eventsById.values()],
      authorizedCapsules: scopedData.capsules,
      viewedRecapIds: readViewedWidgetRecaps(storageSubject),
      contributionPromptsEnabled: true,
    })
  }, [data, storageSubject, theme])

  useEffect(() => {
    if (!isNativeBubbleWidgetAvailable()) return
    const version = ++publishVersionRef.current
    const timer = window.setTimeout(() => {
      void (async () => {
        let thumbnailBase64: string | undefined
        if (selection.thumbnail) {
          const cached = thumbnailCacheRef.current
          if (cached?.source === selection.thumbnail) {
            thumbnailBase64 = cached.dataUrl
          } else {
            thumbnailBase64 = await materializeWidgetThumbnail(selection.thumbnail)
            thumbnailCacheRef.current = {
              source: selection.thumbnail,
              dataUrl: thumbnailBase64,
            }
          }
        }
        if (version !== publishVersionRef.current) return

        const signature = JSON.stringify([selection.snapshot, thumbnailBase64])
        if (signature === lastPayloadRef.current) return
        publishQueueRef.current = publishQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            if (version !== publishVersionRef.current) return
            await updateNativeBubbleWidget(
              selection.snapshot,
              thumbnailBase64,
            )
            lastPayloadRef.current = signature
          })
          .catch(() => undefined)
      })()
    }, 180)
    return () => window.clearTimeout(timer)
  }, [selection])

  // Re-fetch at the next urgency, reveal, close, or day boundary while open.
  useEffect(() => {
    const next = selection.snapshot.nextRefreshAt
    if (!next || !isNativeBubbleWidgetAvailable()) return
    const delay = Math.max(250, Math.min(
      new Date(next).getTime() - Date.now() + 100,
      2_147_000_000,
    ))
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new Event(BUBBLE_WIDGET_DATA_CHANGED_EVENT))
    }, delay)
    return () => window.clearTimeout(timer)
  }, [selection.snapshot.nextRefreshAt])

  return null
}
