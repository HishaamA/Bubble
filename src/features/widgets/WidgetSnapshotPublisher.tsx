import { useEffect, useMemo } from 'react'
import { useAppTheme } from '../../theme/AppTheme'
import { isNativeBubbleWidgetAvailable } from './nativeBubbleWidget'
import { useNativeWidgetPublication } from './useNativeWidgetPublication'
import { useWidgetFamilyData } from './useWidgetFamilyData'
import { projectWidgetEvents } from './widgetEventProjection'
import { selectBubbleWidgetTimeline } from './widgetSnapshot'
import {
  BUBBLE_WIDGET_DATA_CHANGED_EVENT,
  readViewedWidgetRecaps,
  readWidgetChecklistProgress,
  readWidgetCompletedPlanIds,
  readWidgetLocalEvents,
  readWidgetPrivacy,
  readWidgetTaskDefinitions,
} from './widgetStorage'

/** Connects family data, pure widget selection, and the native publication boundary. */
export function WidgetSnapshotPublisher({ storageSubject }: { storageSubject: string }) {
  const { theme } = useAppTheme()
  const data = useWidgetFamilyData(storageSubject)
  const selection = useMemo(() => selectBubbleWidgetTimeline({
    now: data.refreshedAt,
    theme,
    privacy: readWidgetPrivacy(storageSubject),
    events: projectWidgetEvents({
      remoteEvents: data.events,
      localEvents: readWidgetLocalEvents(storageSubject),
      taskDefinitions: readWidgetTaskDefinitions(storageSubject),
      checklist: readWidgetChecklistProgress(storageSubject),
      completedPlanIds: readWidgetCompletedPlanIds(storageSubject),
    }),
    authorizedCapsules: data.capsules,
    authorizedJournalPhotos: data.journalPhotos,
    viewedRecapIds: readViewedWidgetRecaps(storageSubject),
    contributionPromptsEnabled: true,
  }), [data, storageSubject, theme])

  useNativeWidgetPublication(storageSubject, selection)

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
