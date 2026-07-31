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

export function readImageDimensions(file: File): Promise<ImageDimensions> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()

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
