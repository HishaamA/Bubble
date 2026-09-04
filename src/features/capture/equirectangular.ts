export type ImageDimensions = {
  width: number
  height: number
}

export type EquirectangularValidation =
  | {
      valid: true
      ratio: number
      warning?: string
    }
  | {
      valid: false
      ratio: number | null
      message: string
    }

const MIN_RATIO = 1.85
const MAX_RATIO = 2.15
const MAX_PANORAMA_RATIO = 12

export type PanoramaCaptureValidation =
  | {
      valid: true
      ratio: number
      needsNormalization: boolean
      warning?: string
    }
  | {
      valid: false
      ratio: number | null
      message: string
    }

/** Applies shared finite-dimension, resolution, and decoded-pixel safeguards. */
function validateImageBounds(
  dimensions: ImageDimensions,
): { ratio: number } | { error: Extract<PanoramaCaptureValidation, { valid: false }> } {
  const { width, height } = dimensions

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      error: {
        valid: false,
        ratio: null,
        message: 'We could not read this image’s dimensions. Try a different panorama.',
      },
    }
  }

  const ratio = width / height

  if (width < 1024 || height < 256) {
    return {
      error: {
        valid: false,
        ratio,
        message: `This image is ${width} × ${height}. Take a wider, higher-resolution panorama.`,
      },
    }
  }

  if (width * height > 80_000_000) {
    return {
      error: {
        valid: false,
        ratio,
        message: 'This panorama is too large to process safely on this device.',
      },
    }
  }

  return { ratio }
}

/**
 * Accepts both ready-made 2:1 equirectangular images and wide panoramas from a
 * phone's native Pano mode. Wide captures are normalized before they are saved.
 */
export function validatePanoramaCaptureDimensions(
  dimensions: ImageDimensions,
): PanoramaCaptureValidation {
  const bounds = validateImageBounds(dimensions)
  if ('error' in bounds) return bounds.error

  const { ratio } = bounds
  if (ratio < MIN_RATIO || ratio > MAX_PANORAMA_RATIO) {
    return {
      valid: false,
      ratio,
      message:
        ratio < MIN_RATIO
          ? 'This looks like a regular photo. Use Pano or Panorama mode and sweep slowly across the scene.'
          : 'This panorama is unusually wide. Try a shorter, steadier sweep.',
    }
  }

  const needsNormalization = Math.abs(ratio - 2) > 0.01
  return {
    valid: true,
    ratio,
    needsNormalization,
    warning:
      ratio > MAX_RATIO
        ? 'We’ll fit the full phone panorama into a 360°-ready frame. The top and bottom will extend the panorama’s own edge pixels.'
        : dimensions.width < 2048
          ? 'This panorama will work, but a wider capture will look sharper in 360° view.'
          : undefined,
  }
}

/** Applies strict 2:1 validation to an already normalized panorama. */
export function validateEquirectangularDimensions(
  dimensions: ImageDimensions,
): EquirectangularValidation {
  const { width, height } = dimensions

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      valid: false,
      ratio: null,
      message: 'We could not read this image’s dimensions. Try a different panorama.',
    }
  }

  const ratio = width / height

  if (width < 1024 || height < 512) {
    return {
      valid: false,
      ratio,
      message: `This image is ${width} × ${height}. Choose a panorama at least 1024 × 512.`,
    }
  }

  if (width * height > 80_000_000) {
    return {
      valid: false,
      ratio,
      message: 'This panorama is too large to process safely on this device.',
    }
  }

  if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
    return {
      valid: false,
      ratio,
      message: `This image is ${width} × ${height}. Choose a 2:1 equirectangular panorama instead.`,
    }
  }

  return {
    valid: true,
    ratio,
    warning: width < 2048
      ? 'This panorama is correctly shaped, but a wider image will look sharper in 360° view.'
      : undefined,
  }
}

/** Decodes only enough of an image file to read its intrinsic dimensions. */
export function readImageDimensions(file: File): Promise<ImageDimensions> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()

    /** Releases the temporary URL on both image load and decode failure. */
    function finish() {
      URL.revokeObjectURL(objectUrl)
    }

    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
      finish()
    }
    image.onerror = () => {
      reject(new Error('The selected image could not be opened.'))
      finish()
    }
    image.src = objectUrl
  })
}
