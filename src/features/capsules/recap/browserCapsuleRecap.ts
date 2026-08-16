import {
  buildCapsuleRecapPlan,
  CAPSULE_RECAP_FRAME_RATE,
  CAPSULE_RECAP_PHOTO_DURATION_MS,
} from './recapPlan'
import type { CapsuleImageSource, CapsulePhoto } from '../types'

const OUTPUT_WIDTH = 720
const OUTPUT_HEIGHT = 1280

function supportedMimeType() {
  if (typeof MediaRecorder === 'undefined') return null
  const candidates = [
    'video/mp4;codecs=h264',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
}

export function canRenderBrowserCapsuleRecap() {
  return Boolean(
    supportedMimeType() &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'captureStream' in HTMLCanvasElement.prototype,
  )
}

type LoadedImage = {
  image: HTMLImageElement
  release: () => void
}

async function sourceToBlob(source: CapsuleImageSource) {
  if (typeof source !== 'string') return source

  const response = await fetch(source)
  if (!response.ok) {
    throw new Error('One of the Capsule photos could not be opened.')
  }
  return response.blob()
}

async function loadImage(source: CapsuleImageSource): Promise<LoadedImage> {
  const blob = await sourceToBlob(source)
  const url = URL.createObjectURL(blob)
  let released = false
  const release = () => {
    if (released) return
    released = true
    URL.revokeObjectURL(url)
  }

  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    return { image, release }
  } catch (reason) {
    release()
    throw reason
  }
}

async function loadImages(sources: CapsuleImageSource[]) {
  const results = await Promise.allSettled(sources.map(loadImage))
  const loaded: LoadedImage[] = []
  let failure: unknown

  for (const result of results) {
    if (result.status === 'fulfilled') loaded.push(result.value)
    else if (failure === undefined) failure = result.reason
  }

  if (failure !== undefined) {
    loaded.forEach(({ release }) => release())
    throw failure
  }
  return loaded
}

function drawCover(context: CanvasRenderingContext2D, image: HTMLImageElement) {
  const scale = Math.max(OUTPUT_WIDTH / image.naturalWidth, OUTPUT_HEIGHT / image.naturalHeight)
  const width = image.naturalWidth * scale
  const height = image.naturalHeight * scale
  context.fillStyle = '#000'
  context.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT)
  context.drawImage(
    image,
    (OUTPUT_WIDTH - width) / 2,
    (OUTPUT_HEIGHT - height) / 2,
    width,
    height,
  )
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

export async function renderBrowserCapsuleRecap(photos: CapsulePhoto[]) {
  const mimeType = supportedMimeType()
  if (!mimeType || !canRenderBrowserCapsuleRecap()) {
    throw new Error('Compatible video export is not available on this device. Try KinSphere on another supported phone or tablet.')
  }

  const plan = buildCapsuleRecapPlan(photos)
  if (plan.frames.length === 0) throw new Error('Add at least one photo first.')

  const orderedPhotos = [...photos]
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
    .slice(0, plan.frames.length)
  const loadedImages = await loadImages(orderedPhotos.map((photo) => photo.image))
  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_WIDTH
    canvas.height = OUTPUT_HEIGHT
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Video export is unavailable on this device.')

    stream = canvas.captureStream(CAPSULE_RECAP_FRAME_RATE)
    const chunks: Blob[] = []
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 5_000_000,
    })
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }

    const completed = new Promise<Blob>((resolve, reject) => {
      if (!recorder) return reject(new Error('The recap video could not be rendered.'))
      recorder.onerror = () => reject(new Error('The recap video could not be rendered.'))
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }))
    })

    recorder.start()
    for (const { image } of loadedImages) {
      drawCover(context, image)
      await wait(CAPSULE_RECAP_PHOTO_DURATION_MS)
    }
    recorder.stop()
    return await completed
  } finally {
    if (recorder?.state !== 'inactive') recorder?.stop()
    stream?.getTracks().forEach((track) => track.stop())
    loadedImages.forEach(({ release }) => release())
  }
}

export function capsuleRecapFileExtension(blob: Blob) {
  return blob.type.includes('mp4') ? 'mp4' : 'webm'
}
