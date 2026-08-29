import type {
  NativePanoramaCaptureResult,
  NativePanoramaFrame,
} from '../../features/capture/nativePanoramaCapture'
import { nativeFrameSource } from '../../features/capture/nativePanoramaCapture'
import type { ProcessedPanorama } from './processPanorama'

const DEFAULT_OUTPUT_WIDTH = 2048
const THUMBNAIL_WIDTH = 640
const SAMPLE_WIDTH = 960
const MIN_CAPTURED_FRAMES = 8
const NO_FRAME = 255
const MIN_EXPOSURE_SCALE = 0.82
const MAX_EXPOSURE_SCALE = 1.22
const EXPOSURE_CORRECTION_STRENGTH = 0.55
const SEAM_BLEND_START = 0.78
const SEAM_BLEND_FULL = 0.98
const OVERLAP_SAMPLE_STRIDE = 4
const OVERLAP_MIN_DOMINANCE_RATIO = 0.18
const OVERLAP_HISTOGRAM_BINS = 81
const OVERLAP_MAX_LOG_RATIO = Math.log(2)
const OVERLAP_MIN_SAMPLES = 48

type Vec3 = readonly [number, number, number]

export type GuidedCameraBasis = {
  forward: Vec3
  right: Vec3
  up: Vec3
}

export type GuidedFrameOrientation = {
  yawDegrees: number
  pitchDegrees: number
  rollDegrees: number
}

export type GuidedPanoramaProgress = {
  phase: 'reading' | 'projecting' | 'encoding'
  completed: number
  total: number
}

export type GuidedExposureConstraint = {
  firstFrameIndex: number
  secondFrameIndex: number
  logGainDifference: number
  sampleCount: number
}

type DecodedFrame = {
  image: HTMLImageElement
  close: () => void
}

function firstFinite(...values: Array<number | undefined>) {
  return values.find((value): value is number => Number.isFinite(value))
}

export function resolveFrameOrientation(
  frame: NativePanoramaFrame,
): GuidedFrameOrientation {
  // The actual camera pose is authoritative. Target angles describe where the
  // guide dot was placed, not the exact optical axis at shutter time. Using the
  // target first can stamp many nearly identical frames around a fake sphere.
  const yawDegrees = firstFinite(
    frame.yawDegrees,
    frame.yaw,
    frame.targetYawDegrees,
    frame.targetYaw,
  )
  const pitchDegrees = firstFinite(
    frame.pitchDegrees,
    frame.pitch,
    frame.targetPitchDegrees,
    frame.targetPitch,
  )
  const rollDegrees = firstFinite(
    frame.rollDegrees,
    frame.roll,
    0,
  )

  if (yawDegrees === undefined || pitchDegrees === undefined) {
    throw new Error('A captured frame is missing its spherical orientation.')
  }

  return { yawDegrees, pitchDegrees, rollDegrees: rollDegrees ?? 0 }
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1
  return [vector[0] / length, vector[1] / length, vector[2] / length]
}

function addScaled(
  forward: Vec3,
  right: Vec3,
  up: Vec3,
  x: number,
  y: number,
): Vec3 {
  return normalize([
    forward[0] + right[0] * x + up[0] * y,
    forward[1] + right[1] * x + up[1] * y,
    forward[2] + right[2] * x + up[2] * y,
  ])
}

export function createCameraBasis(
  orientation: GuidedFrameOrientation,
): GuidedCameraBasis {
  const yaw = orientation.yawDegrees * (Math.PI / 180)
  const pitch = orientation.pitchDegrees * (Math.PI / 180)
  const roll = orientation.rollDegrees * (Math.PI / 180)
  const sinYaw = Math.sin(yaw)
  const cosYaw = Math.cos(yaw)
  const sinPitch = Math.sin(pitch)
  const cosPitch = Math.cos(pitch)

  const forward: Vec3 = [
    cosPitch * sinYaw,
    sinPitch,
    cosPitch * cosYaw,
  ]
  const levelRight: Vec3 = [cosYaw, 0, -sinYaw]
  const levelUp: Vec3 = [
    -sinPitch * sinYaw,
    cosPitch,
    -sinPitch * cosYaw,
  ]

  return {
    forward,
    right: normalize([
      levelRight[0] * Math.cos(roll) + levelUp[0] * Math.sin(roll),
      levelRight[1] * Math.cos(roll) + levelUp[1] * Math.sin(roll),
      levelRight[2] * Math.cos(roll) + levelUp[2] * Math.sin(roll),
    ]),
    up: normalize([
      levelUp[0] * Math.cos(roll) - levelRight[0] * Math.sin(roll),
      levelUp[1] * Math.cos(roll) - levelRight[1] * Math.sin(roll),
      levelUp[2] * Math.cos(roll) - levelRight[2] * Math.sin(roll),
    ]),
  }
}

function finiteTransform(transform: number[] | undefined) {
  return transform?.length === 16 && transform.every(Number.isFinite)
    ? transform
    : undefined
}

/**
 * Uses the native pose matrix when available, preserving the exact camera
 * orientation and roll captured by ARKit. Native coordinates look down -Z;
 * the compositor reflects world Z so its zero-yaw convention looks down +Z.
 */
export function resolveFrameCameraBasis(
  frame: NativePanoramaFrame,
): GuidedCameraBasis {
  const transform = finiteTransform(frame.transform)
  if (!transform) return createCameraBasis(resolveFrameOrientation(frame))

  return {
    right: normalize([transform[0], transform[1], -transform[2]]),
    up: normalize([transform[4], transform[5], -transform[6]]),
    forward: normalize([-transform[8], -transform[9], transform[10]]),
  }
}

export function directionToEquirectangular(
  direction: Vec3,
  outputWidth: number,
  outputHeight: number,
) {
  const yaw = Math.atan2(direction[0], direction[2])
  const pitch = Math.asin(Math.max(-1, Math.min(1, direction[1])))
  return {
    x: ((yaw / (Math.PI * 2) + 0.5) * outputWidth + outputWidth) % outputWidth,
    y: (0.5 - pitch / Math.PI) * outputHeight,
  }
}

async function decodeFrame(source: string): Promise<DecodedFrame> {
  const image = new Image()
  image.decoding = 'async'
  image.src = source
  await image.decode()
  return { image, close: () => { image.src = '' } }
}

function getCanvasContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: true,
  })
  if (!context) throw new Error('This device cannot assemble a 360° image.')
  return context
}

export type GuidedFrameCalibration = {
  fx: number
  fy: number
  cx: number
  cy: number
}

export function resolveFrameCalibration(
  frame: NativePanoramaFrame,
  sampleWidth: number,
  sampleHeight: number,
): GuidedFrameCalibration {
  const intrinsicFx = frame.intrinsics?.[0]
  const intrinsicFy = frame.intrinsics?.[4]
  const intrinsicCx = frame.intrinsics?.[2]
  const intrinsicCy = frame.intrinsics?.[5]
  const hasFocalLength =
    Number.isFinite(intrinsicFx) &&
    Number.isFinite(intrinsicFy) &&
    (intrinsicFx as number) > 0 &&
    (intrinsicFy as number) > 0
  if (
    hasFocalLength &&
    frame.width > 0 &&
    frame.height > 0
  ) {
    const sourceCx = Number.isFinite(intrinsicCx)
      ? (intrinsicCx as number)
      : (frame.width - 1) / 2
    const sourceCy = Number.isFinite(intrinsicCy)
      ? (intrinsicCy as number)
      : (frame.height - 1) / 2
    const rotation = (
      (Math.round(frame.rotationDegrees ?? 0) % 360) + 360
    ) % 360
    if (rotation === 90) {
      return {
        fx: (intrinsicFy as number) * (sampleWidth / frame.height),
        fy: (intrinsicFx as number) * (sampleHeight / frame.width),
        cx: (frame.height - 1 - sourceCy) * (sampleWidth / frame.height),
        cy: sourceCx * (sampleHeight / frame.width),
      }
    }
    if (rotation === 180) {
      return {
        fx: (intrinsicFx as number) * (sampleWidth / frame.width),
        fy: (intrinsicFy as number) * (sampleHeight / frame.height),
        cx: (frame.width - 1 - sourceCx) * (sampleWidth / frame.width),
        cy: (frame.height - 1 - sourceCy) * (sampleHeight / frame.height),
      }
    }
    if (rotation === 270) {
      return {
        fx: (intrinsicFy as number) * (sampleWidth / frame.height),
        fy: (intrinsicFx as number) * (sampleHeight / frame.width),
        cx: sourceCy * (sampleWidth / frame.height),
        cy: (frame.width - 1 - sourceCx) * (sampleHeight / frame.width),
      }
    }
    return {
      fx: (intrinsicFx as number) * (sampleWidth / frame.width),
      fy: (intrinsicFy as number) * (sampleHeight / frame.height),
      cx: sourceCx * (sampleWidth / frame.width),
      cy: sourceCy * (sampleHeight / frame.height),
    }
  }

  const horizontalFov = Math.max(
    35,
    Math.min(110, frame.horizontalFovDegrees ?? 68),
  )
  const fx = sampleWidth / (2 * Math.tan((horizontalFov * Math.PI) / 360))
  const verticalFov = frame.verticalFovDegrees
  const fy = verticalFov
    ? sampleHeight / (2 * Math.tan((verticalFov * Math.PI) / 360))
    : fx
  return {
    fx,
    fy,
    cx: (sampleWidth - 1) / 2,
    cy: (sampleHeight - 1) / 2,
  }
}

/**
 * Estimates a frame's brightness without letting a few deep shadows or clipped
 * highlights dictate the result. Sampling keeps this inexpensive on the full
 * camera frame; trimming the histogram makes it steadier than a plain mean.
 */
export function calculateRobustFrameLuma(data: Uint8ClampedArray) {
  const histogram = new Uint32Array(256)
  let sampleCount = 0
  for (let index = 0; index + 2 < data.length; index += 64) {
    const luma = Math.max(0, Math.min(255, Math.round(
      data[index] * 0.2126 +
      data[index + 1] * 0.7152 +
      data[index + 2] * 0.0722,
    )))
    histogram[luma] += 1
    sampleCount += 1
  }
  if (!sampleCount) return 128

  const trimCount = Math.floor(sampleCount * 0.08)
  const firstIncluded = trimCount
  const lastExcluded = sampleCount - trimCount
  let visited = 0
  let included = 0
  let total = 0
  for (let luma = 0; luma < histogram.length; luma += 1) {
    const binStart = visited
    const binEnd = visited + histogram[luma]
    const usable = Math.max(
      0,
      Math.min(binEnd, lastExcluded) - Math.max(binStart, firstIncluded),
    )
    total += luma * usable
    included += usable
    visited = binEnd
  }
  return included ? total / included : 128
}

function median(values: number[]) {
  if (!values.length) return 128
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

/**
 * Uses the median frame brightness as an order-independent reference. A
 * partial, bounded correction avoids turning genuinely dark or bright parts of
 * the room into exposure errors while still reducing camera exposure jumps.
 */
export function resolveExposureScales(frameLumas: number[]) {
  const safeLumas = frameLumas.map((luma) =>
    Number.isFinite(luma) && luma > 0 ? luma : 128,
  )
  const referenceLuma = median(safeLumas)
  return safeLumas.map((luma) => Math.max(
    MIN_EXPOSURE_SCALE,
    Math.min(
      MAX_EXPOSURE_SCALE,
      (referenceLuma / luma) ** EXPOSURE_CORRECTION_STRENGTH,
    ),
  ))
}

/**
 * Solves relative exposure from pixels that two frames actually share. Pair
 * constraints describe log(gainA) - log(gainB), so the result does not depend
 * on which frame was captured first. Each connected overlap component is
 * centred around a neutral gain; isolated frames use the conservative global
 * fallback above.
 */
export function solveOverlapExposureScales(
  frameLumas: number[],
  constraints: GuidedExposureConstraint[],
) {
  const frameCount = frameLumas.length
  const fallbackScales = resolveExposureScales(frameLumas)
  if (!frameCount || !constraints.length) return fallbackScales

  const parent = Array.from({ length: frameCount }, (_, index) => index)
  const find = (frameIndex: number): number => {
    let root = frameIndex
    while (parent[root] !== root) root = parent[root]
    while (parent[frameIndex] !== frameIndex) {
      const next = parent[frameIndex]
      parent[frameIndex] = root
      frameIndex = next
    }
    return root
  }
  const union = (left: number, right: number) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }

  const validConstraints = constraints.filter((constraint) => {
    const isValid =
      Number.isInteger(constraint.firstFrameIndex) &&
      Number.isInteger(constraint.secondFrameIndex) &&
      constraint.firstFrameIndex >= 0 &&
      constraint.secondFrameIndex >= 0 &&
      constraint.firstFrameIndex < frameCount &&
      constraint.secondFrameIndex < frameCount &&
      constraint.firstFrameIndex !== constraint.secondFrameIndex &&
      Number.isFinite(constraint.logGainDifference) &&
      constraint.sampleCount > 0
    if (isValid) {
      union(constraint.firstFrameIndex, constraint.secondFrameIndex)
    }
    return isValid
  })
  if (!validConstraints.length) return fallbackScales

  const connected = new Uint8Array(frameCount)
  validConstraints.forEach((constraint) => {
    connected[constraint.firstFrameIndex] = 1
    connected[constraint.secondFrameIndex] = 1
  })
  let logGains = new Float64Array(frameCount)
  const minimumLogGain = Math.log(MIN_EXPOSURE_SCALE)
  const maximumLogGain = Math.log(MAX_EXPOSURE_SCALE)

  for (let iteration = 0; iteration < 28; iteration += 1) {
    const totals = new Float64Array(frameCount)
    const weights = new Float64Array(frameCount)
    validConstraints.forEach((constraint) => {
      const first = constraint.firstFrameIndex
      const second = constraint.secondFrameIndex
      const weight = Math.min(32, Math.sqrt(constraint.sampleCount))
      totals[first] += weight * (
        logGains[second] + constraint.logGainDifference
      )
      totals[second] += weight * (
        logGains[first] - constraint.logGainDifference
      )
      weights[first] += weight
      weights[second] += weight
    })

    const nextLogGains = new Float64Array(logGains)
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      if (!weights[frameIndex]) continue
      const proposal = totals[frameIndex] / weights[frameIndex]
      nextLogGains[frameIndex] =
        logGains[frameIndex] * 0.4 + proposal * 0.6
    }

    const componentValues = new Map<number, number[]>()
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      if (!connected[frameIndex]) continue
      const root = find(frameIndex)
      const values = componentValues.get(root) ?? []
      values.push(nextLogGains[frameIndex])
      componentValues.set(root, values)
    }
    const componentCentres = new Map<number, number>()
    componentValues.forEach((values, root) => {
      componentCentres.set(root, median(values))
    })
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      if (!connected[frameIndex]) continue
      const centred = nextLogGains[frameIndex] -
        (componentCentres.get(find(frameIndex)) ?? 0)
      nextLogGains[frameIndex] = Math.max(
        minimumLogGain,
        Math.min(maximumLogGain, centred),
      )
    }
    logGains = nextLogGains
  }

  return Array.from({ length: frameCount }, (_, frameIndex) =>
    connected[frameIndex]
      ? Math.exp(logGains[frameIndex])
      : fallbackScales[frameIndex],
  )
}

type ExposurePairHistogram = {
  firstFrameIndex: number
  secondFrameIndex: number
  bins: Uint32Array
  sampleCount: number
}

function rawLuma(red: number, green: number, blue: number) {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722
}

function collectOverlapExposureConstraints(
  bestColors: Uint32Array,
  secondColors: Uint32Array,
  bestDominance: Uint8Array,
  secondDominance: Uint8Array,
  bestFrameIndices: Uint8Array,
  secondFrameIndices: Uint8Array,
) {
  const pairs = new Map<number, ExposurePairHistogram>()

  for (
    let pixelIndex = 0;
    pixelIndex < bestDominance.length;
    pixelIndex += OVERLAP_SAMPLE_STRIDE
  ) {
    const bestScore = bestDominance[pixelIndex]
    const secondScore = secondDominance[pixelIndex]
    if (
      !bestScore ||
      !secondScore ||
      secondScore / bestScore < OVERLAP_MIN_DOMINANCE_RATIO
    ) continue

    const bestFrameIndex = bestFrameIndices[pixelIndex]
    const secondFrameIndex = secondFrameIndices[pixelIndex]
    if (
      bestFrameIndex === NO_FRAME ||
      secondFrameIndex === NO_FRAME ||
      bestFrameIndex === secondFrameIndex
    ) continue

    const bestColor = bestColors[pixelIndex]
    const secondColor = secondColors[pixelIndex]
    const bestRed = redFromRgb(bestColor)
    const bestGreen = greenFromRgb(bestColor)
    const bestBlue = blueFromRgb(bestColor)
    const secondRed = redFromRgb(secondColor)
    const secondGreen = greenFromRgb(secondColor)
    const secondBlue = blueFromRgb(secondColor)
    const bestLuma = rawLuma(bestRed, bestGreen, bestBlue)
    const secondLuma = rawLuma(secondRed, secondGreen, secondBlue)
    if (
      bestLuma < 10 ||
      secondLuma < 10 ||
      bestLuma > 245 ||
      secondLuma > 245
    ) continue

    // Exposure preserves chroma. Reject likely parallax/moving-object samples
    // before they can influence a neighboring frame's gain.
    const chromaDistance = Math.max(
      Math.abs(bestRed / bestLuma - secondRed / secondLuma),
      Math.abs(bestBlue / bestLuma - secondBlue / secondLuma),
    )
    if (chromaDistance > 0.22) continue

    const firstFrameIndex = Math.min(bestFrameIndex, secondFrameIndex)
    const secondSortedFrameIndex = Math.max(bestFrameIndex, secondFrameIndex)
    const pairKey = firstFrameIndex * NO_FRAME + secondSortedFrameIndex
    let pair = pairs.get(pairKey)
    if (!pair) {
      pair = {
        firstFrameIndex,
        secondFrameIndex: secondSortedFrameIndex,
        bins: new Uint32Array(OVERLAP_HISTOGRAM_BINS),
        sampleCount: 0,
      }
      pairs.set(pairKey, pair)
    }

    const firstLuma = bestFrameIndex === firstFrameIndex
      ? bestLuma
      : secondLuma
    const secondSortedLuma = bestFrameIndex === firstFrameIndex
      ? secondLuma
      : bestLuma
    const logGainDifference = Math.max(
      -OVERLAP_MAX_LOG_RATIO,
      Math.min(
        OVERLAP_MAX_LOG_RATIO,
        Math.log(secondSortedLuma / firstLuma),
      ),
    )
    const normalized = (
      logGainDifference + OVERLAP_MAX_LOG_RATIO
    ) / (OVERLAP_MAX_LOG_RATIO * 2)
    const binIndex = Math.max(0, Math.min(
      OVERLAP_HISTOGRAM_BINS - 1,
      Math.round(normalized * (OVERLAP_HISTOGRAM_BINS - 1)),
    ))
    pair.bins[binIndex] += 1
    pair.sampleCount += 1
  }

  const constraints: GuidedExposureConstraint[] = []
  pairs.forEach((pair) => {
    if (pair.sampleCount < OVERLAP_MIN_SAMPLES) return
    const medianSample = Math.floor((pair.sampleCount - 1) / 2)
    let visited = 0
    let medianBin = 0
    for (; medianBin < pair.bins.length; medianBin += 1) {
      visited += pair.bins[medianBin]
      if (visited > medianSample) break
    }
    const normalized = medianBin / (OVERLAP_HISTOGRAM_BINS - 1)
    constraints.push({
      firstFrameIndex: pair.firstFrameIndex,
      secondFrameIndex: pair.secondFrameIndex,
      logGainDifference:
        normalized * OVERLAP_MAX_LOG_RATIO * 2 - OVERLAP_MAX_LOG_RATIO,
      sampleCount: pair.sampleCount,
    })
  })
  return constraints
}

function smoothstep(start: number, end: number, value: number) {
  const progress = Math.max(0, Math.min(1, (value - start) / (end - start)))
  return progress * progress * (3 - 2 * progress)
}

/**
 * Returns the fraction of the second source to mix into the winning source.
 * The blend exists only in a narrow ownership boundary and disappears when
 * the two sources disagree, preserving a crisp single image around parallax or
 * moving people rather than creating transparent duplicates.
 */
export function calculateAdaptiveSeamMix(
  bestDominance: number,
  secondDominance: number,
  bestRed: number,
  bestGreen: number,
  bestBlue: number,
  secondRed: number,
  secondGreen: number,
  secondBlue: number,
) {
  if (bestDominance <= 0 || secondDominance <= 0) return 0
  const dominanceRatio = secondDominance / bestDominance
  if (dominanceRatio <= SEAM_BLEND_START) return 0

  const redDifference = bestRed - secondRed
  const greenDifference = bestGreen - secondGreen
  const blueDifference = bestBlue - secondBlue
  const colorDistance = Math.sqrt(
    (redDifference ** 2 + greenDifference ** 2 + blueDifference ** 2) / 3,
  )
  const averageLuma = (
    bestRed * 0.2126 +
    bestGreen * 0.7152 +
    bestBlue * 0.0722 +
    secondRed * 0.2126 +
    secondGreen * 0.7152 +
    secondBlue * 0.0722
  ) / 2
  const agreementStart = 9 + averageLuma * 0.045
  const agreementEnd = 20 + averageLuma * 0.075
  const agreement = 1 - smoothstep(
    agreementStart,
    agreementEnd,
    colorDistance,
  )
  if (agreement <= 0) return 0

  const seamProximity = smoothstep(
    SEAM_BLEND_START,
    SEAM_BLEND_FULL,
    dominanceRatio,
  )
  const weightedSecondShare = secondDominance /
    (bestDominance + secondDominance)
  return Math.min(0.5, seamProximity * agreement * weightedSecondShare)
}

function packRgb(red: number, green: number, blue: number) {
  return (red << 16) | (green << 8) | blue
}

function redFromRgb(color: number) {
  return (color >>> 16) & 0xff
}

function greenFromRgb(color: number) {
  return (color >>> 8) & 0xff
}

function blueFromRgb(color: number) {
  return color & 0xff
}

function exposedChannel(channel: number, exposureScale: number) {
  return Math.max(0, channel * exposureScale)
}

function canvasToJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error('The 360° image could not be encoded.')),
      'image/jpeg',
      quality,
    )
  })
}

function fillUncoveredPixels(
  pixels: Uint8ClampedArray,
  coverage: Uint8Array,
  width: number,
  height: number,
) {
  for (let pass = 0; pass < 10; pass += 1) {
    let filled = 0
    const nextCoverage = coverage.slice()
    const nextPixels = pixels.slice()

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x
        if (coverage[pixelIndex]) continue

        let red = 0
        let green = 0
        let blue = 0
        let neighbors = 0
        const neighborCoordinates = [
          [(x + width - 1) % width, y],
          [(x + 1) % width, y],
          [x, Math.max(0, y - 1)],
          [x, Math.min(height - 1, y + 1)],
        ]
        for (const [neighborX, neighborY] of neighborCoordinates) {
          const neighborIndex = neighborY * width + neighborX
          if (!coverage[neighborIndex]) continue
          const colorIndex = neighborIndex * 4
          red += pixels[colorIndex]
          green += pixels[colorIndex + 1]
          blue += pixels[colorIndex + 2]
          neighbors += 1
        }
        if (!neighbors) continue

        const colorIndex = pixelIndex * 4
        nextPixels[colorIndex] = red / neighbors
        nextPixels[colorIndex + 1] = green / neighbors
        nextPixels[colorIndex + 2] = blue / neighbors
        nextPixels[colorIndex + 3] = 255
        nextCoverage[pixelIndex] = 1
        filled += 1
      }
    }

    pixels.set(nextPixels)
    coverage.set(nextCoverage)
    if (!filled) break
  }
}

function nextPaint() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 0)
    }
  })
}

/**
 * Creates an equirectangular sphere from pose-tagged native frames. This is a
 * bounded on-device compositor: the native capture targets provide geometric
 * alignment and overlapping samples are exposure-balanced. Each panorama
 * pixel prefers the source closest to its optical centre. Only a narrow seam
 * between two visually compatible sources is feathered; averaging every
 * overlap creates transparent duplicate people and objects whenever there is
 * handheld parallax or movement in the room.
 * A native OpenCV stitcher can replace this implementation behind the same
 * capture contract without changing the Moments upload flow.
 */
export async function composeGuidedPanorama(
  result: NativePanoramaCaptureResult,
  onProgress?: (progress: GuidedPanoramaProgress) => void,
  outputWidth = DEFAULT_OUTPUT_WIDTH,
): Promise<ProcessedPanorama> {
  if (typeof document === 'undefined') {
    throw new Error('Panorama assembly requires an installed app or browser canvas.')
  }
  if (result.frames.length < MIN_CAPTURED_FRAMES) {
    throw new Error('Capture more of the surrounding dots before finishing.')
  }
  if (result.frames.length >= NO_FRAME) {
    throw new Error('This capture contains too many source pictures to assemble.')
  }
  if (!Number.isFinite(outputWidth) || outputWidth < 1024) {
    throw new TypeError('The panorama output must be at least 1024 pixels wide.')
  }

  const safeOutputWidth = Math.min(4096, Math.round(outputWidth / 2) * 2)
  const outputHeight = safeOutputWidth / 2
  const outputPixels = safeOutputWidth * outputHeight
  const bestColors = new Uint32Array(outputPixels)
  const secondColors = new Uint32Array(outputPixels)
  const bestDominance = new Uint8Array(outputPixels)
  const secondDominance = new Uint8Array(outputPixels)
  const bestFrameIndices = new Uint8Array(outputPixels)
  const secondFrameIndices = new Uint8Array(outputPixels)
  bestFrameIndices.fill(NO_FRAME)
  secondFrameIndices.fill(NO_FRAME)
  const frameLumas = new Array<number>(result.frames.length)
  const sampleCanvas = document.createElement('canvas')
  const sampleContext = getCanvasContext(sampleCanvas)

  for (let frameIndex = 0; frameIndex < result.frames.length; frameIndex += 1) {
    const frame = result.frames[frameIndex]
    onProgress?.({
      phase: 'reading',
      completed: frameIndex,
      total: result.frames.length,
    })
    const decoded = await decodeFrame(nativeFrameSource(frame))
    try {
      const sourceWidth = decoded.image.naturalWidth || frame.width
      const sourceHeight = decoded.image.naturalHeight || frame.height
      const scale = Math.min(1, SAMPLE_WIDTH / sourceWidth)
      const sampleWidth = Math.max(1, Math.round(sourceWidth * scale))
      const sampleHeight = Math.max(1, Math.round(sourceHeight * scale))
      sampleCanvas.width = sampleWidth
      sampleCanvas.height = sampleHeight
      sampleContext.drawImage(decoded.image, 0, 0, sampleWidth, sampleHeight)
      const imageData = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight)
      frameLumas[frameIndex] = calculateRobustFrameLuma(imageData.data)
      const basis = resolveFrameCameraBasis(frame)
      const { fx, fy, cx, cy } = resolveFrameCalibration(
        frame,
        sampleWidth,
        sampleHeight,
      )
      const leftRadius = Math.max(1, cx)
      const rightRadius = Math.max(1, sampleWidth - 1 - cx)
      const topRadius = Math.max(1, cy)
      const bottomRadius = Math.max(1, sampleHeight - 1 - cy)

      onProgress?.({
        phase: 'projecting',
        completed: frameIndex,
        total: result.frames.length,
      })

      for (let y = 0; y < sampleHeight; y += 1) {
        const cameraY = -(y - cy) / fy
        const normalizedY = Math.abs(
          (y - cy) / (y < cy ? topRadius : bottomRadius),
        )
        for (let x = 0; x < sampleWidth; x += 1) {
          const cameraX = (x - cx) / fx
          const normalizedX = Math.abs(
            (x - cx) / (x < cx ? leftRadius : rightRadius),
          )
          const edgeDistance = Math.max(normalizedX, normalizedY)
          if (edgeDistance > 0.985) continue
          const direction = addScaled(
            basis.forward,
            basis.right,
            basis.up,
            cameraX,
            cameraY,
          )
          const projected = directionToEquirectangular(
            direction,
            safeOutputWidth,
            outputHeight,
          )
          const destinationX = Math.floor(projected.x) % safeOutputWidth
          const destinationY = Math.max(
            0,
            Math.min(outputHeight - 1, Math.floor(projected.y)),
          )
          const destinationIndex = destinationY * safeOutputWidth + destinationX
          const sourceIndex = (y * sampleWidth + x) * 4
          const candidateDominance = Math.max(
            1,
            Math.round((1 - edgeDistance) ** 2 * 255),
          )
          const candidateColor = packRgb(
            imageData.data[sourceIndex],
            imageData.data[sourceIndex + 1],
            imageData.data[sourceIndex + 2],
          )
          const currentBestFrame = bestFrameIndices[destinationIndex]

          if (currentBestFrame === frameIndex) {
            if (candidateDominance > bestDominance[destinationIndex]) {
              bestDominance[destinationIndex] = candidateDominance
              bestColors[destinationIndex] = candidateColor
            }
            continue
          }

          if (candidateDominance > bestDominance[destinationIndex]) {
            secondDominance[destinationIndex] = bestDominance[destinationIndex]
            secondColors[destinationIndex] = bestColors[destinationIndex]
            secondFrameIndices[destinationIndex] = currentBestFrame
            bestDominance[destinationIndex] = candidateDominance
            bestColors[destinationIndex] = candidateColor
            bestFrameIndices[destinationIndex] = frameIndex
            continue
          }

          if (secondFrameIndices[destinationIndex] === frameIndex) {
            if (candidateDominance > secondDominance[destinationIndex]) {
              secondDominance[destinationIndex] = candidateDominance
              secondColors[destinationIndex] = candidateColor
            }
            continue
          }

          if (candidateDominance > secondDominance[destinationIndex]) {
            secondDominance[destinationIndex] = candidateDominance
            secondColors[destinationIndex] = candidateColor
            secondFrameIndices[destinationIndex] = frameIndex
          }
        }
      }
    } finally {
      decoded.close()
    }
    await nextPaint()
  }

  const outputCanvas = document.createElement('canvas')
  outputCanvas.width = safeOutputWidth
  outputCanvas.height = outputHeight
  const outputContext = getCanvasContext(outputCanvas)
  const outputImage = outputContext.createImageData(safeOutputWidth, outputHeight)
  const coverage = new Uint8Array(outputPixels)
  const exposureConstraints = collectOverlapExposureConstraints(
    bestColors,
    secondColors,
    bestDominance,
    secondDominance,
    bestFrameIndices,
    secondFrameIndices,
  )
  const exposureScales = solveOverlapExposureScales(
    frameLumas,
    exposureConstraints,
  )
  let coveredPixels = 0
  for (let index = 0; index < outputPixels; index += 1) {
    const colorIndex = index * 4
    if (bestDominance[index]) {
      const bestFrameIndex = bestFrameIndices[index]
      const bestColor = bestColors[index]
      const bestExposure = exposureScales[bestFrameIndex] ?? 1
      const bestRed = exposedChannel(redFromRgb(bestColor), bestExposure)
      const bestGreen = exposedChannel(greenFromRgb(bestColor), bestExposure)
      const bestBlue = exposedChannel(blueFromRgb(bestColor), bestExposure)
      const secondFrameIndex = secondFrameIndices[index]
      const hasDistinctSecond = secondDominance[index] > 0 &&
        secondFrameIndex !== NO_FRAME &&
        secondFrameIndex !== bestFrameIndex

      if (hasDistinctSecond) {
        const secondColor = secondColors[index]
        const secondExposure = exposureScales[secondFrameIndex] ?? 1
        const secondRed = exposedChannel(redFromRgb(secondColor), secondExposure)
        const secondGreen = exposedChannel(greenFromRgb(secondColor), secondExposure)
        const secondBlue = exposedChannel(blueFromRgb(secondColor), secondExposure)
        const secondMix = calculateAdaptiveSeamMix(
          bestDominance[index],
          secondDominance[index],
          bestRed,
          bestGreen,
          bestBlue,
          secondRed,
          secondGreen,
          secondBlue,
        )
        outputImage.data[colorIndex] = Math.round(
          bestRed + (secondRed - bestRed) * secondMix,
        )
        outputImage.data[colorIndex + 1] = Math.round(
          bestGreen + (secondGreen - bestGreen) * secondMix,
        )
        outputImage.data[colorIndex + 2] = Math.round(
          bestBlue + (secondBlue - bestBlue) * secondMix,
        )
      } else {
        outputImage.data[colorIndex] = bestRed
        outputImage.data[colorIndex + 1] = bestGreen
        outputImage.data[colorIndex + 2] = bestBlue
      }
      coverage[index] = 1
      coveredPixels += 1
    }
    outputImage.data[colorIndex + 3] = 255
  }

  if (coveredPixels / outputPixels < 0.72) {
    throw new Error('Too much of the sphere is missing. Retake the uncaptured dots.')
  }

  fillUncoveredPixels(
    outputImage.data,
    coverage,
    safeOutputWidth,
    outputHeight,
  )
  outputContext.putImageData(outputImage, 0, 0)
  onProgress?.({ phase: 'encoding', completed: 0, total: 1 })

  const thumbnailCanvas = document.createElement('canvas')
  thumbnailCanvas.width = THUMBNAIL_WIDTH
  thumbnailCanvas.height = THUMBNAIL_WIDTH / 2
  const thumbnailContext = getCanvasContext(thumbnailCanvas)
  thumbnailContext.drawImage(
    outputCanvas,
    0,
    0,
    thumbnailCanvas.width,
    thumbnailCanvas.height,
  )

  const [viewer, thumbnail] = await Promise.all([
    canvasToJpeg(outputCanvas, 0.9),
    canvasToJpeg(thumbnailCanvas, 0.82),
  ])
  onProgress?.({ phase: 'encoding', completed: 1, total: 1 })

  return {
    viewer,
    thumbnail,
    viewerWidth: safeOutputWidth,
    viewerHeight: outputHeight,
    thumbnailWidth: THUMBNAIL_WIDTH,
    thumbnailHeight: THUMBNAIL_WIDTH / 2,
  }
}
