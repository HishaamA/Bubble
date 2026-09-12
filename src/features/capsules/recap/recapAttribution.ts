import { capsuleContributorAvatarUrl, capsuleContributorInitials } from '../capsuleContributor'
import type { CapsulePhoto } from '../types'

type Contributor = Pick<CapsulePhoto, 'contributorName' | 'contributorAvatarUrl'>
type LoadedAvatar = { image: HTMLImageElement; release: () => void }

const AVATAR_TIMEOUT_MS = 5_000
const MAX_AVATAR_BYTES = 2 * 1024 * 1024

function requireActiveAvatar(signal: AbortSignal) {
  if (signal.aborted) throw new Error('Profile photo loading expired.')
}

async function readAvatarBlob(response: Response, signal: AbortSignal): Promise<Blob> {
  requireActiveAvatar(signal)
  const declaredSize = Number(response.headers?.get('content-length'))
  if (declaredSize > MAX_AVATAR_BYTES) throw new Error('Profile photo is too large.')

  const reader = response.body?.getReader()
  if (!reader) {
    // Older webviews may not expose streaming bodies. The deadline still applies.
    const blob = await response.blob()
    requireActiveAvatar(signal)
    if (blob.size > MAX_AVATAR_BYTES) throw new Error('Profile photo is too large.')
    return blob
  }

  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const chunks: ArrayBuffer[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      requireActiveAvatar(signal)
      if (done) break
      size += value.byteLength
      if (size > MAX_AVATAR_BYTES) {
        cancel()
        throw new Error('Profile photo is too large.')
      }
      chunks.push(new Uint8Array(value).buffer)
    }
    return new Blob(chunks, { type: response.headers?.get('content-type') ?? '' })
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/** Decodes through an owned object URL, so remote avatars cannot taint a canvas. */
async function withDecodedImage<T>(blob: Blob, renderImage: (image: HTMLImageElement) => T | Promise<T>) {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    return await renderImage(image)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** An unavailable profile photo must not prevent exporting the family's memories. */
export async function loadRecapAvatar(contributor: Contributor): Promise<LoadedAvatar | null> {
  const url = capsuleContributorAvatarUrl(contributor.contributorAvatarUrl)
  if (!url) return null
  const controller = new AbortController()
  let objectUrl: string | undefined
  let activeImage: HTMLImageElement | undefined
  const release = () => {
    if (activeImage) activeImage.src = ''
    activeImage = undefined
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = undefined
  }
  const load = async (): Promise<LoadedAvatar | null> => {
    const response = await fetch(url, { referrerPolicy: 'no-referrer', signal: controller.signal })
    if (!response.ok) {
      controller.abort()
      return null
    }
    const blob = await readAvatarBlob(response, controller.signal)
    requireActiveAvatar(controller.signal)
    objectUrl = URL.createObjectURL(blob)
    const image = new Image()
    activeImage = image
    image.decoding = 'async'
    image.src = objectUrl
    await image.decode()
    requireActiveAvatar(controller.signal)
    return { image, release }
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort()
      // Decode can stall even after fetch has finished. Release its URL here,
      // without waiting for decode (or an endpoint ignoring abort) to settle.
      release()
      resolve(null)
    }, AVATAR_TIMEOUT_MS)
  })
  try {
    return await Promise.race([load(), deadline])
  } catch {
    controller.abort()
    release()
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Adds the same top-right uploader badge to browser frames and native staging. */
export function drawRecapAttribution(
  context: CanvasRenderingContext2D,
  contributor: Contributor,
  avatar: HTMLImageElement | null,
  width: number,
) {
  const radius = width * 0.06
  const inset = width * 0.04
  const x = width - inset - radius
  const y = inset + radius
  context.save()
  try {
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fillStyle = '#e9b4c6'
    context.fill()
    context.save()
    try {
      context.clip()
      if (avatar) {
        const size = Math.min(avatar.naturalWidth, avatar.naturalHeight)
        context.drawImage(avatar,
          (avatar.naturalWidth - size) / 2, (avatar.naturalHeight - size) / 2,
          size, size, x - radius, y - radius, radius * 2, radius * 2)
      } else {
        context.fillStyle = '#351126'
        context.font = `700 ${Math.round(radius * 0.72)}px sans-serif`
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText(capsuleContributorInitials(contributor.contributorName), x, y, radius * 1.7)
      }
    } finally {
      context.restore()
    }
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.strokeStyle = '#fff3d4'
    context.lineWidth = Math.max(2, width * 0.004)
    context.stroke()
  } finally {
    context.restore()
  }
}

/** Sequential, bounded 1080p frames retain attribution in iOS and Android MP4s. */
export async function prepareAttributedRecapFrame(imageBlob: Blob, contributor: Contributor): Promise<Blob> {
  const avatar = await loadRecapAvatar(contributor)
  try {
    return await withDecodedImage(imageBlob, async (image) => {
      const canvas = document.createElement('canvas')
      canvas.width = 1080
      canvas.height = 1920
      try {
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('This phone could not prepare the family recap.')
        const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
        const width = image.naturalWidth * scale
        const height = image.naturalHeight * scale
        context.fillStyle = '#000'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
        drawRecapAttribution(context, contributor, avatar?.image ?? null, canvas.width)
        return await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((blob) => blob
            ? resolve(blob)
            : reject(new Error('This phone could not prepare the family recap.')), 'image/jpeg', 0.92)
        })
      } finally {
        // Release each 1080p backing buffer before staging the next frame.
        canvas.width = 0
        canvas.height = 0
      }
    })
  } finally {
    avatar?.release()
  }
}
