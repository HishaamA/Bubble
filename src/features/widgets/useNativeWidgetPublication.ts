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

  useEffect(() => {
    if (!isNativeBubbleWidgetAvailable()) return
    const cache = thumbnailCacheRef.current
    return () => {
      publishVersionRef.current += 1
      lastPayloadRef.current = ''
      cache.clear()
      // Clear independently of family fetches, even when the device is offline.
      void clearNativeBubbleWidget().catch(() => undefined)
    }
  }, [storageSubject])

  useEffect(() => {
    if (!isNativeBubbleWidgetAvailable()) return
    const version = ++publishVersionRef.current
    const controller = new AbortController()
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
        for (const [key, source] of sources) {
          if (controller.signal.aborted) return
          if (cache.has(key)) continue
          // Small, sequential thumbnails leave the UI free between images.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
          if (controller.signal.aborted) return
          const image = await materializeWidgetThumbnail(source, controller.signal)
          if (controller.signal.aborted || version !== publishVersionRef.current) return
          if (image) cache.set(key, image)
        }
        if (version !== publishVersionRef.current) return

        const thumbnailBase64 = selection.thumbnail ? cache.get(widgetThumbnailCacheKey(selection.thumbnail)) : undefined
        const pageThumbnails = Object.fromEntries(pageSources.flatMap(([id, source]) => {
          const image = cache.get(widgetThumbnailCacheKey(source))
          return image ? [[id, image]] : []
        }))
        // A foreground refresh must not reset the user's chosen native page
        // solely because the clock advanced. Midnight is still a hard boundary.
        const signature = JSON.stringify([
          { ...selection.snapshot, generatedAt: toLocalDateInput(new Date(selection.snapshot.generatedAt)) },
          thumbnailBase64,
          pageThumbnails,
        ])
        if (signature === lastPayloadRef.current) return
        publishQueueRef.current = publishQueueRef.current
          // A failed bridge write must not poison subsequent queued updates.
          .catch(() => undefined)
          .then(async () => {
            if (version !== publishVersionRef.current) return
            if (Object.keys(pageThumbnails).length > 0) {
              await updateNativeBubbleWidget(selection.snapshot, thumbnailBase64, pageThumbnails)
            } else {
              await updateNativeBubbleWidget(selection.snapshot, thumbnailBase64)
            }
            lastPayloadRef.current = signature
          })
          .catch(() => undefined)
      })()
    }, selection.snapshot.privacy === 'hidden' ? 0 : 180)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [selection, storageSubject])
}
