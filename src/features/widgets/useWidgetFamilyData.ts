import { useEffect, useMemo, useState } from 'react'
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
import {
  fetchFamilyJournalPhotos,
  subscribeToFamilyJournalPhotos,
} from '../journal/journalPhotoService'
import type { JournalPhoto } from '../journal/journalPhotoTypes'
import { isNativeBubbleWidgetAvailable } from './nativeBubbleWidget'
import { BUBBLE_WIDGET_DATA_CHANGED_EVENT } from './widgetStorage'
import { useHiddenContent, photoVisibilityKey, capsuleVisibilityKey } from '../journal/contentVisibility'
import { applyCapsuleRemovals } from '../capsules/capsuleRemovalState'

type WidgetFamilyData = {
  storageSubject: string
  events: FamilyEventRecord[]
  capsules: FamilyCapsule[]
  journalPhotos: JournalPhoto[]
  refreshedAt: Date
  localRevision: number
}

/** Owns account-scoped subscriptions; slow photo reads never block plan refreshes. */
export function useWidgetFamilyData(storageSubject: string): WidgetFamilyData {
  const hidden = useHiddenContent(storageSubject)
  const [data, setData] = useState<WidgetFamilyData>(() => ({
    storageSubject,
    events: [],
    capsules: [],
    journalPhotos: [],
    refreshedAt: new Date(),
    localRevision: 0,
  }))

  useEffect(() => {
    if (!isNativeBubbleWidgetAvailable()) return
    let active = true
    let stopEvents: () => void = () => undefined
    let stopCapsules: () => void = () => undefined
    let stopJournalPhotos: () => void = () => undefined
    let refreshVersion = 0
    let journalRefreshPending = false
    let journalRefreshDirty = false
    let journalRefreshedAt = 0

    function refreshJournalPhotos(force = false) {
      if (!active) return
      if (journalRefreshPending) {
        journalRefreshDirty ||= force
        return
      }
      if (!force && Date.now() - journalRefreshedAt < 30_000) return
      journalRefreshPending = true
      // Journal can contain years of uploads. Its metadata request must never
      // hold up planner updates or multiply when preferences are toggled fast.
      void fetchFamilyJournalPhotos(storageSubject).then((journalPhotos) => {
        if (!active) return
        journalRefreshedAt = Date.now()
        setData((current) => ({
          ...current,
          storageSubject,
          ...(current.storageSubject !== storageSubject ? { events: [], capsules: [] } : {}),
          journalPhotos: journalPhotos ?? [],
          refreshedAt: new Date(),
          localRevision: current.localRevision + 1,
        }))
      // Preserve authorized cached photos offline; the next refresh can retry.
      }).catch(() => undefined).finally(() => {
        journalRefreshPending = false
        if (!active || !journalRefreshDirty) return
        journalRefreshDirty = false
        refreshJournalPhotos(true)
      })
    }

    async function refresh() {
      const version = ++refreshVersion
      refreshJournalPhotos()
      const [events, capsules] = await Promise.allSettled([
        fetchFamilyEvents({ includeEarlierToday: true }),
        fetchFamilyCapsules(),
      ])
      if (!active || version !== refreshVersion) return
      setData((current) => ({
        storageSubject,
        events: events.status === 'fulfilled'
          ? events.value
          : current.storageSubject === storageSubject ? current.events : [],
        capsules: capsules.status === 'fulfilled'
          ? capsules.value
          : current.storageSubject === storageSubject ? current.capsules : [],
        journalPhotos: current.storageSubject === storageSubject ? current.journalPhotos : [],
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
    // Realtime is best effort; foreground and local changes also refresh data.
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
    void subscribeToFamilyJournalPhotos(() => refreshJournalPhotos(true), storageSubject)
      .then((stop) => {
        if (active) stopJournalPhotos = stop
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
      stopEvents()
      stopCapsules()
      stopJournalPhotos()
      window.removeEventListener('online', refresh)
      window.removeEventListener('storage', refresh)
      window.removeEventListener(
        BUBBLE_WIDGET_DATA_CHANGED_EVENT,
        republishFromMemoryThenRefresh,
      )
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [storageSubject])

  // The new account's first render must not project the previous account's data.
  return useMemo(() => {
    if (data.storageSubject === storageSubject) return {
      ...data,
      journalPhotos: data.journalPhotos.filter((photo) => !hidden.includes(photoVisibilityKey(photo.id, 'journal-photo'))),
      capsules: applyCapsuleRemovals(data.capsules, storageSubject)
        .filter((capsule) => !hidden.includes(capsuleVisibilityKey(capsule.id)))
        .map((capsule) => ({ ...capsule, photos: capsule.photos.filter((photo) => !hidden.includes(photoVisibilityKey(photo.id, 'capsule-photo'))) })),
    }
    return {
      ...data,
      storageSubject,
      events: [],
      capsules: [],
      journalPhotos: [],
      refreshedAt: new Date(),
    }
  }, [data, hidden, storageSubject])
}
