import type {
  NativePanoramaCaptureResult,
  NativePanoramaFrame,
} from '../../features/capture/nativePanoramaCapture'
import { nativeFrameSource } from '../../features/capture/nativePanoramaCapture'
import type { ProcessedPanorama } from './processPanorama'

const DEFAULT_OUTPUT_WIDTH = 2048
const THUMBNAIL_WIDTH = 640
const SAMPLE_WIDTH = 720
const MIN_CAPTURED_FRAMES = 8

type Vec3 = readonly [number, number, number]

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
  const yawDegrees = firstFinite(
    frame.targetYawDegrees,
    frame.targetYaw,
    frame.yawDegrees,
    frame.yaw,
  )
  const pitchDegrees = firstFinite(
    frame.targetPitchDegrees,
    frame.targetPitch,
    frame.pitchDegrees,
    frame.pitch,
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
): { forward: Vec3; right: Vec3; up: Vec3 } {
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

function frameFocalLength(
  frame: NativePanoramaFrame,
  sampleWidth: number,
  sampleHeight: number,
) {
  const intrinsicFx = frame.intrinsics?.[0]
  const intrinsicFy = frame.intrinsics?.[4]
  if (
    Number.isFinite(intrinsicFx) &&
    Number.isFinite(intrinsicFy) &&
    (intrinsicFx as number) > 0 &&
    (intrinsicFy as number) > 0 &&
    frame.width > 0 &&
    frame.height > 0
  ) {
    const quarterTurn = Math.abs(Math.round(frame.rotationDegrees ?? 0) % 180) === 90
    if (quarterTurn) {
      return {
        fx: (intrinsicFy as number) * (sampleWidth / frame.height),
        fy: (intrinsicFx as number) * (sampleHeight / frame.width),
      }
    }
    return {
      fx: (intrinsicFx as number) * (sampleWidth / frame.width),
      fy: (intrinsicFy as number) * (sampleHeight / frame.height),
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
  return { fx, fy }
}

function calculateAverageLuma(data: Uint8ClampedArray) {
  let total = 0
  let count = 0
  for (let index = 0; index < data.length; index += 64) {
    total +=
      data[index] * 0.2126 +
      data[index + 1] * 0.7152 +
      data[index + 2] * 0.0722
    count += 1
  }
  return count ? total / count : 128
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
 * alignment and overlapping samples are exposure-balanced and feathered.
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
  if (!Number.isFinite(outputWidth) || outputWidth < 1024) {
    throw new TypeError('The panorama output must be at least 1024 pixels wide.')
  }

  const safeOutputWidth = Math.min(4096, Math.round(outputWidth / 2) * 2)
  const outputHeight = safeOutputWidth / 2
  const outputPixels = safeOutputWidth * outputHeight
  const red = new Uint32Array(outputPixels)
  const green = new Uint32Array(outputPixels)
  const blue = new Uint32Array(outputPixels)
  const weights = new Uint32Array(outputPixels)
  const sampleCanvas = document.createElement('canvas')
  const sampleContext = getCanvasContext(sampleCanvas)
  let referenceLuma: number | undefined

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
      const luma = calculateAverageLuma(imageData.data)
      referenceLuma ??= luma
      const exposure = Math.max(0.72, Math.min(1.38, referenceLuma / Math.max(1, luma)))
      const orientation = resolveFrameOrientation(frame)
      const basis = createCameraBasis(orientation)
      const { fx, fy } = frameFocalLength(frame, sampleWidth, sampleHeight)
      const centerX = (sampleWidth - 1) / 2
      const centerY = (sampleHeight - 1) / 2

      onProgress?.({
        phase: 'projecting',
        completed: frameIndex,
        total: result.frames.length,
      })

      for (let y = 0; y < sampleHeight; y += 1) {
        const cameraY = -(y - centerY) / fy
        const normalizedY = Math.abs((y - centerY) / Math.max(1, centerY))
        for (let x = 0; x < sampleWidth; x += 1) {
          const cameraX = (x - centerX) / fx
          const normalizedX = Math.abs((x - centerX) / Math.max(1, centerX))
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
          const feather = Math.max(1, Math.round((1 - edgeDistance) ** 2 * 64))
          red[destinationIndex] += Math.min(255, imageData.data[sourceIndex] * exposure) * feather
          green[destinationIndex] += Math.min(255, imageData.data[sourceIndex + 1] * exposure) * feather
          blue[destinationIndex] += Math.min(255, imageData.data[sourceIndex + 2] * exposure) * feather
          weights[destinationIndex] += feather
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
  let coveredPixels = 0
  for (let index = 0; index < outputPixels; index += 1) {
    const colorIndex = index * 4
    const weight = weights[index]
    if (weight) {
      outputImage.data[colorIndex] = red[index] / weight
      outputImage.data[colorIndex + 1] = green[index] / weight
      outputImage.data[colorIndex + 2] = blue[index] / weight
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
