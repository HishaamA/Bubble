import type { ProcessedCapsulePhoto } from './types'

const MAX_IMAGE_EDGE = 2048
const MAX_THUMBNAIL_EDGE = 560
const MAX_DECODED_PIXELS = 80_000_000
const JPEG_QUALITY = 0.88

export function acceptsCapsuleImage(file: Pick<File, 'type' | 'size'>) {
  return file.size > 0 && file.size <= 25 * 1024 * 1024 && file.type.startsWith('image/')
}

export function hasSafeCapsuleImageDimensions(width: number, height: number) {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_DECODED_PIXELS / height
  )
}

function fitWithin(width: number, height: number, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('This photo could not be prepared.')),
      'image/jpeg',
      quality,
    )
  })
}

async function decodeImage(file: File) {
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = objectUrl
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function renderImage(
  image: HTMLImageElement,
  dimensions: { width: number; height: number },
) {
  const canvas = document.createElement('canvas')
  canvas.width = dimensions.width
  canvas.height = dimensions.height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Photo processing is unavailable on this device.')
  context.drawImage(image, 0, 0, dimensions.width, dimensions.height)
  return canvas
}

/**
 * Re-encodes any browser-decodable photo to metadata-free JPEG. Unlike the
 * Moments capture pipeline, regular Capsule photos have no aspect-ratio rule.
 */
export async function processCapsuleImage(file: File): Promise<ProcessedCapsulePhoto> {
  if (!acceptsCapsuleImage(file)) {
    throw new Error('Choose one regular photo smaller than 25 MB.')
  }

  let image: HTMLImageElement
  try {
    image = await decodeImage(file)
  } catch {
    throw new Error('That photo format is not supported on this phone.')
  }

  if (!hasSafeCapsuleImageDimensions(image.naturalWidth, image.naturalHeight)) {
    throw new Error('That photo is too large to prepare safely on this phone.')
  }

  const fullSize = fitWithin(image.naturalWidth, image.naturalHeight, MAX_IMAGE_EDGE)
  const thumbnailSize = fitWithin(image.naturalWidth, image.naturalHeight, MAX_THUMBNAIL_EDGE)
  const fullCanvas = renderImage(image, fullSize)
  const thumbnailCanvas = renderImage(image, thumbnailSize)
  const [preparedImage, thumbnail] = await Promise.all([
    canvasToBlob(fullCanvas, JPEG_QUALITY),
    canvasToBlob(thumbnailCanvas, 0.78),
  ])

  return {
    image: preparedImage,
    thumbnail,
    width: fullSize.width,
    height: fullSize.height,
    thumbnailWidth: thumbnailSize.width,
    thumbnailHeight: thumbnailSize.height,
  }
}
