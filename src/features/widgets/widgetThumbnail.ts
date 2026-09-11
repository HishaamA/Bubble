import type { CapsuleImageSource } from '../capsules/types'

export const MAX_WIDGET_THUMBNAIL_BYTES = 320 * 1_024
const maxSourceBytes = 8 * 1_024 * 1_024
const maxDimension = 384

/**
 * Converts one authorized image into a byte- and dimension-bounded data URL.
 * Failure is intentionally soft: text-only widgets remain useful offline or
 * when a signed Storage URL expires.
 */
export async function materializeWidgetThumbnail(
  source: CapsuleImageSource,
): Promise<string | undefined> {
  try {
    const blob = await sourceBlob(source)
    if (!blob || blob.size > maxSourceBytes || !blob.type.startsWith('image/')) {
      return undefined
    }

    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
      return blob.size <= MAX_WIDGET_THUMBNAIL_BYTES
        ? await blobDataUrl(blob)
        : undefined
    }

    const bitmap = await createImageBitmap(blob)
    try {
      const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) return undefined
      context.drawImage(bitmap, 0, 0, width, height)

      for (const quality of [0.82, 0.68, 0.54]) {
        const thumbnail = await canvasBlob(canvas, quality)
        if (thumbnail && thumbnail.size <= MAX_WIDGET_THUMBNAIL_BYTES) {
          return await blobDataUrl(thumbnail)
        }
      }
      return undefined
    } finally {
      bitmap.close()
    }
  } catch {
    return undefined
  }
}

async function sourceBlob(source: CapsuleImageSource) {
  if (source instanceof Blob) return source
  if (source.length > 10_000_000) return null
  const url = source.trim()
  if (!url || (!url.startsWith('data:image/') && !url.startsWith('blob:') && !/^https?:\/\//i.test(url))) {
    return null
  }
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) return null
  return await response.blob()
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality)
  })
}

function blobDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Image read failed.'))
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Image read failed.'))
    }
    reader.readAsDataURL(blob)
  })
}
