export type ReferenceImageDimensions = {
  /** Upright decoded dimensions, after orientation and an aspect-preserving resize. */
  width: number
  height: number
}

export type ReferenceFieldOfViewEstimate = {
  horizontalFovDegrees: number
  source: 'exif-35mm-equivalent' | 'diagonal-fallback'
  /** Neither camera EXIF nor the default is a calibrated projection. */
  estimated: true
}

export type ReferenceFieldOfViewInput = ReferenceImageDimensions & {
  /** Read metadata before making a transfer copy that strips EXIF. */
  original: Blob
}

const DEFAULT_DIAGONAL_FOV_DEGREES = 74
const FULL_FRAME_DIAGONAL_MM = Math.hypot(36, 24)
const EXIF_FOCAL_LENGTH_OPTIONS = {
  // Follow the IFD0 pointer to EXIF without returning IFD0 or unrelated blocks.
  tiff: false,
  ifd1: false,
  exif: { pick: [0xa405] }, // FocalLengthIn35mmFormat in exifr's EXIF dictionary.
  gps: false,
  interop: false,
  xmp: false,
  icc: false,
  iptc: false,
  jfif: false,
  makerNote: false,
  userComment: false,
  chunked: true,
} as const

function assertDimensions({ width, height }: ReferenceImageDimensions) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error('Reference photo dimensions must be positive integers.')
  }
}

function horizontalDegrees(diagonalTangent: number, { width, height }: ReferenceImageDimensions) {
  const degrees = 2 * Math.atan(diagonalTangent * width / Math.hypot(width, height)) * 180 / Math.PI
  // Keep the projection in its supported range, without pretending EXIF is calibration.
  return Math.round(Math.max(25, Math.min(110, degrees)) * 10) / 10
}

/**
 * Uses only 35mm-equivalent focal length, whose crop factor is based on image
 * diagonals (CIPA DCG-X001). Physical focal length alone cannot identify sensor size.
 * The supplied dimensions are already upright: never apply EXIF orientation twice.
 * Edited crops/digital zoom can make focal-length metadata inaccurate, so every
 * result remains an estimate. No raw metadata, device identifier, or GPS is returned.
 */
export async function estimateReferenceFieldOfView(
  original: Blob,
  dimensions: ReferenceImageDimensions,
): Promise<ReferenceFieldOfViewEstimate> {
  assertDimensions(dimensions)
  try {
    const { parse } = await import('exifr/dist/lite.esm.mjs')
    const metadata = await parse(original, EXIF_FOCAL_LENGTH_OPTIONS)
    const focal35 = metadata?.FocalLengthIn35mmFormat
    // EXIF specifies a numeric millimetre value; zero means unknown.
    if (typeof focal35 === 'number' && Number.isFinite(focal35) && focal35 > 0) {
      return {
        horizontalFovDegrees: horizontalDegrees(FULL_FRAME_DIAGONAL_MM / (2 * focal35), dimensions),
        source: 'exif-35mm-equivalent',
        estimated: true,
      }
    }
  } catch {
    // Missing, unsupported, or damaged EXIF must not block a reference photo.
  }
  return {
    horizontalFovDegrees: horizontalDegrees(Math.tan(DEFAULT_DIAGONAL_FOV_DEGREES * Math.PI / 360), dimensions),
    source: 'diagonal-fallback',
    estimated: true,
  }
}

/** Only the bounded angles need to enter the generator's horizontalFovs array. */
export async function estimateReferenceHorizontalFovs(
  references: readonly ReferenceFieldOfViewInput[],
): Promise<number[]> {
  if (references.length < 1 || references.length > 4) {
    throw new Error('Choose between one and four reference photos.')
  }
  // Validate the whole request before reading any original file.
  references.forEach(assertDimensions)
  const estimates = await Promise.all(references.map(({ original, width, height }) =>
    estimateReferenceFieldOfView(original, { width, height }),
  ))
  return estimates.map(({ horizontalFovDegrees }) => horizontalFovDegrees)
}
