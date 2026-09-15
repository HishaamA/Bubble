import { useEffect, useRef } from 'react'
import { toLocalDateInput } from '../capsules/capsuleDates'
import type { CapsuleImageSource } from '../capsules/types'
import {
  clearNativeBubbleWidget,
  isNativeBubbleWidgetAvailable,
  updateNativeBubbleWidget,
} from './nativeBubbleWidget'
import type { BubbleWidgetSelection } from './widgetSnapshot'
import { materializeWidgetThumbnail } from './widgetThumbnail'
import { widgetThumbnailCacheKey } from './widgetThumbnailCacheKey'

/** Serializes native writes and owns all thumbnail work for one signed-in scope. */
export function useNativeWidgetPublication(
  storageSubject: string,
  selection: BubbleWidgetSelection,
) {
  const publishQueueRef = useRef(Promise.resolve())
  const publishVersionRef = useRef(0)
  const lastPayloadRef = useRef('')
  const thumbnailCacheRef = useRef(new Map<CapsuleImageSource, string>())
  // Keep removals urgent through intervening renders until native storage has
  // actually accepted a non-flight snapshot (not just until React selected it).
  const flightClearPendingRef = useRef(false)

  useEffect(() => {
    if (!isNativeBubbleWidgetAvailable()) return
    const cache = thumbnailCacheRef.current
    return () => {
      publishVersionRef.current += 1
      lastPayloadRef.current = ''
      flightClearPendingRef.current = false
      cache.clear()
      // Clear independently of family fetches, even when the device is offline.
      void clearNativeBubbleWidget().catch(() => undefined)
    }
  }, [storageSubject])

  useEffect(() => {
    if (!isNativeBubbleWidgetAvailable()) return
    const version = ++publishVersionRef.current
    const controller = new AbortController()
    const containsFlight = selection.snapshot.kind === 'flight'
      || selection.snapshot.pages?.some((page) => page.kind === 'flight') === true
      || selection.snapshot.schedule?.some((card) => card.kind === 'flight') === true
    if (containsFlight) flightClearPendingRef.current = true
    if (selection.snapshot.privacy === 'hidden') thumbnailCacheRef.current.clear()
    const timer = window.setTimeout(() => {
      void (async () => {
        const pageSources = Object.entries(selection.pageThumbnails ?? {}).slice(0, 8)
        const sources = new Map([
          ...(selection.thumbnail ? [selection.thumbnail] : []),
          ...pageSources.map(([, source]) => source),
        ].map((source) => [widgetThumbnailCacheKey(source), source]))
        const cache = thumbnailCacheRef.current
        for (const source of cache.keys()) {
          if (!sources.has(source)) cache.delete(source)
        }

        async function publishAvailableMedia() {
          if (controller.signal.aborted || version !== publishVersionRef.current) return
          const thumbnailBase64 = selection.thumbnail ? cache.get(widgetThumbnailCacheKey(selection.thumbnail)) : undefined
          const pageThumbnails = Object.fromEntries(pageSources.flatMap(([id, source]) => {
            const image = cache.get(widgetThumbnailCacheKey(source))
            return image ? [[id, image]] : []
          }))
          // Preserve manual page selection through unchanged foreground refreshes.
          const signature = JSON.stringify([
            { ...selection.snapshot, generatedAt: toLocalDateInput(new Date(selection.snapshot.generatedAt)) },
            thumbnailBase64,
            pageThumbnails,
          ])
          if (signature === lastPayloadRef.current) return
          publishQueueRef.current = publishQueueRef.current
            .catch(() => undefined)
            .then(async () => {
              if (controller.signal.aborted || version !== publishVersionRef.current
                || signature === lastPayloadRef.current) return
              if (Object.keys(pageThumbnails).length > 0) {
                await updateNativeBubbleWidget(selection.snapshot, thumbnailBase64, pageThumbnails)
              } else {
                await updateNativeBubbleWidget(selection.snapshot, thumbnailBase64)
              }
              // A bridge call already in progress cannot be aborted. Its late
              // completion must not rewrite a replacement scope's bookkeeping.
              if (controller.signal.aborted || version !== publishVersionRef.current) return
              lastPayloadRef.current = signature
              if (!containsFlight) flightClearPendingRef.current = false
            })
            .catch(() => undefined)
          await publishQueueRef.current
        }

        // Maps/timetables are ready now. Do not hide them (or leave an old
        // flight behind) while unrelated gallery thumbnails are still loading.
        // Cached images remain attached, with identical page IDs/order; the
        // same serialized publication path supplements new images afterward.
        if (containsFlight || flightClearPendingRef.current) await publishAvailableMedia()
        for (const [key, source] of sources) {
          if (controller.signal.aborted) return
          if (cache.has(key)) continue
          // Small, sequential thumbnails leave the UI free between images.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
          if (controller.signal.aborted) return
          const image = await materializeWidgetThumbnail(source, controller.signal).catch(() => undefined)
          if (controller.signal.aborted || version !== publishVersionRef.current) return
          if (image) cache.set(key, image)
        }
        await publishAvailableMedia()
      })().catch(() => undefined)
    }, selection.snapshot.privacy === 'hidden' ? 0 : 180)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [selection, storageSubject])
}
