export type PanoramaCrop = {
  sourceX: number
  sourceY: number
  sourceWidth: number
  sourceHeight: number
  viewerWidth: number
  viewerHeight: number
  thumbnailWidth: number
  thumbnailHeight: number
}

export type ProcessedPanorama = {
  viewer: Blob
  thumbnail: Blob
  viewerWidth: number
  viewerHeight: number
  thumbnailWidth: number
  thumbnailHeight: number
}

const MAX_INPUT_BYTES = 25 * 1024 * 1024
const MAX_INPUT_PIXELS = 80_000_000
const MAX_VIEWER_HEIGHT = 2048
const THUMBNAIL_HEIGHT = 320

export function calculatePanoramaCrop(
  width: number,
  height: number,
): PanoramaCrop {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError('Panorama dimensions must be positive numbers.')
  }

  const ratio = width / height
  if (ratio < 1.85 || ratio > 2.15) {
    throw new TypeError('Choose a 2:1 equirectangular panorama.')
  }
  if (width * height > MAX_INPUT_PIXELS) {
    throw new TypeError('This panorama is too large to process safely on this device.')
  }

  const sourceWidth = ratio >= 2 ? height * 2 : width
  const sourceHeight = ratio >= 2 ? height : width / 2
  const sourceX = (width - sourceWidth) / 2
  const sourceY = (height - sourceHeight) / 2
  const viewerHeight = Math.max(
    1,
    Math.min(MAX_VIEWER_HEIGHT, Math.floor(sourceHeight)),
  )
  const thumbnailHeight = Math.min(THUMBNAIL_HEIGHT, viewerHeight)

  return {
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    viewerWidth: viewerHeight * 2,
    viewerHeight,
    thumbnailWidth: thumbnailHeight * 2,
    thumbnailHeight,
  }
}

type DecodedImage = {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

async function decodeImage(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    }
  }

  if (typeof document === 'undefined') {
    throw new Error('Panorama processing requires a browser image decoder.')
  }

  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  image.decoding = 'async'
  image.src = objectUrl

  try {
    await image.decode()
  } catch {
    URL.revokeObjectURL(objectUrl)
    throw new Error('The selected panorama could not be decoded.')
  }

  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close: () => URL.revokeObjectURL(objectUrl),
  }
}

function renderJpeg(
  image: CanvasImageSource,
  crop: PanoramaCrop,
  outputWidth: number,
  outputHeight: number,
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = outputWidth
  canvas.height = outputHeight
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('This device cannot process the panorama.')

  context.drawImage(
    image,
    crop.sourceX,
    crop.sourceY,
    crop.sourceWidth,
    crop.sourceHeight,
    0,
    0,
    outputWidth,
    outputHeight,
  )

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error('The panorama could not be encoded.')),
      'image/jpeg',
      quality,
    )
  })
}

/**
 * Re-encodes only derivatives, which strips EXIF and other source metadata.
 * The original File remains local and is never returned for upload.
 */
export async function processPanoramaForSharing(
  file: File,
): Promise<ProcessedPanorama> {
  if (!file.type.startsWith('image/')) {
    throw new TypeError('Choose an image file.')
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new TypeError('Choose a panorama smaller than 25 MB.')
  }
  if (typeof document === 'undefined') {
    throw new Error('Panorama processing requires a browser canvas.')
  }

  const decoded = await decodeImage(file)
  try {
    const crop = calculatePanoramaCrop(decoded.width, decoded.height)
    const [viewer, thumbnail] = await Promise.all([
      renderJpeg(
        decoded.source,
        crop,
        crop.viewerWidth,
        crop.viewerHeight,
        0.88,
      ),
      renderJpeg(
        decoded.source,
        crop,
        crop.thumbnailWidth,
        crop.thumbnailHeight,
        0.8,
      ),
    ])

    return {
      viewer,
      thumbnail,
      viewerWidth: crop.viewerWidth,
      viewerHeight: crop.viewerHeight,
      thumbnailWidth: crop.thumbnailWidth,
      thumbnailHeight: crop.thumbnailHeight,
    }
  } finally {
    decoded.close()
  }
}
