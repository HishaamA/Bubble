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

export type PanoramaRenderPlan = PanoramaCrop & {
  mode: 'equirectangular-crop' | 'wide-panorama-fit'
  /** Destination values are expressed from 0–1 so one plan fits every derivative. */
  contentTop: number
  contentHeight: number
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
const MAX_PANORAMA_RATIO = 12

/**
 * Crops a near-2:1 equirectangular source to exact viewer dimensions without
 * stretching it. Use `calculatePanoramaRenderPlan` for wider phone panoramas.
 */
export function calculatePanoramaCrop(
  width: number,
  height: number,
): PanoramaCrop {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new TypeError('Panorama dimensions must be positive numbers.')
  }

  const ratio = width / height
  if (ratio < 1.85 || ratio > 2.15) {
    throw new TypeError('Choose a 2:1 equirectangular panorama.')
  }
  if (width * height > MAX_INPUT_PIXELS) {
    throw new TypeError(
      'This panorama is too large to process safely on this device.',
    )
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

/**
 * Produces an exact 2:1 render plan while retaining the full horizontal sweep
 * of a wide panorama captured in a phone's native Pano mode.
 */
export function calculatePanoramaRenderPlan(
  width: number,
  height: number,
): PanoramaRenderPlan {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new TypeError('Panorama dimensions must be positive numbers.')
  }
  if (width * height > MAX_INPUT_PIXELS) {
    throw new TypeError(
      'This panorama is too large to process safely on this device.',
    )
  }

  const ratio = width / height
  if (ratio < 1.85 || ratio > MAX_PANORAMA_RATIO) {
    throw new TypeError('Use a wide photo captured with Pano or Panorama mode.')
  }

  if (ratio <= 2.15) {
    return {
      ...calculatePanoramaCrop(width, height),
      mode: 'equirectangular-crop',
      contentTop: 0,
      contentHeight: 1,
    }
  }

  const viewerHeight = Math.max(
    1,
    Math.min(MAX_VIEWER_HEIGHT, Math.floor(width / 2)),
  )
  const thumbnailHeight = Math.min(THUMBNAIL_HEIGHT, viewerHeight)
  const contentHeight = 2 / ratio

  return {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: width,
    sourceHeight: height,
    viewerWidth: viewerHeight * 2,
    viewerHeight,
    thumbnailWidth: thumbnailHeight * 2,
    thumbnailHeight,
    mode: 'wide-panorama-fit',
    contentTop: (1 - contentHeight) / 2,
    contentHeight,
  }
}

type DecodedImage = {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

/** Uses ImageBitmap when available and revokes fallback object URLs on close. */
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

/** Draws one metadata-free JPEG derivative according to the shared plan. */
function renderJpeg(
  imageSource: CanvasImageSource,
  plan: PanoramaRenderPlan,
  outputWidth: number,
  outputHeight: number,
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = outputWidth
  canvas.height = outputHeight
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('This device cannot process the panorama.')

  if (plan.mode === 'wide-panorama-fit') {
    const contentTop = Math.round(outputHeight * plan.contentTop)
    const contentHeight = Math.max(
      1,
      Math.round(outputHeight * plan.contentHeight),
    )
    const bottomStart = Math.min(outputHeight, contentTop + contentHeight)

    // Extend the panorama's own edge rows into the spherical poles. This keeps
    // the whole horizontal sweep without inventing unrelated imagery or color.
    if (contentTop > 0) {
      context.drawImage(
        imageSource,
        0,
        0,
        plan.sourceWidth,
        1,
        0,
        0,
        outputWidth,
        contentTop,
      )
    }
    if (bottomStart < outputHeight) {
      context.drawImage(
        imageSource,
        0,
        Math.max(0, plan.sourceHeight - 1),
        plan.sourceWidth,
        1,
        0,
        bottomStart,
        outputWidth,
        outputHeight - bottomStart,
      )
    }
    context.drawImage(
      imageSource,
      0,
      0,
      plan.sourceWidth,
      plan.sourceHeight,
      0,
      contentTop,
      outputWidth,
      contentHeight,
    )
  } else {
    context.drawImage(
      imageSource,
      plan.sourceX,
      plan.sourceY,
      plan.sourceWidth,
      plan.sourceHeight,
      0,
      0,
      outputWidth,
      outputHeight,
    )
  }

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

  const decodedImage = await decodeImage(file)
  try {
    const renderPlan = calculatePanoramaRenderPlan(
      decodedImage.width,
      decodedImage.height,
    )
    const [viewerImage, thumbnailImage] = await Promise.all([
      renderJpeg(
        decodedImage.source,
        renderPlan,
        renderPlan.viewerWidth,
        renderPlan.viewerHeight,
        0.88,
      ),
      renderJpeg(
        decodedImage.source,
        renderPlan,
        renderPlan.thumbnailWidth,
        renderPlan.thumbnailHeight,
        0.8,
      ),
    ])

    return {
      viewer: viewerImage,
      thumbnail: thumbnailImage,
      viewerWidth: renderPlan.viewerWidth,
      viewerHeight: renderPlan.viewerHeight,
      thumbnailWidth: renderPlan.thumbnailWidth,
      thumbnailHeight: renderPlan.thumbnailHeight,
    }
  } finally {
    decodedImage.close()
  }
}
