import { Capacitor, registerPlugin } from '@capacitor/core'

export const CAPSULE_RECAP_FRAME_RATE = 30 as const
export const CAPSULE_RECAP_FRAMES_PER_IMAGE = 6 as const
export const CAPSULE_RECAP_MILLISECONDS_PER_IMAGE = 200 as const

export type StagedCapsuleRecapImage = {
  /** A private temporary file URL understood only by the native recap plugin. */
  path: string
}

export type NativeCapsuleRecapResult = {
  /** A file:// URL for the temporary H.264 MP4. */
  fileUri: string
  width: 1080
  height: 1920
  frameRate: typeof CAPSULE_RECAP_FRAME_RATE
  framesPerImage: typeof CAPSULE_RECAP_FRAMES_PER_IMAGE
  durationMs: number
  imageCount: number
}

export type NativeCapsuleRecapShareResult = {
  completed: boolean
  activityType?: string
}

type CapsuleRecapPlugin = {
  stageImage(options: { dataUrl: string }): Promise<StagedCapsuleRecapImage>
  renderRecap(options: {
    imagePaths: string[]
  }): Promise<NativeCapsuleRecapResult>
  shareRecap(options: {
    fileUri: string
  }): Promise<NativeCapsuleRecapShareResult>
  discardArtifacts(options: {
    fileUris: string[]
  }): Promise<{ removedCount: number }>
}

type CapsuleRecapRegistry = typeof globalThis & {
  __kinsphereCapsuleRecap?: CapsuleRecapPlugin
}

const pluginRegistry = globalThis as CapsuleRecapRegistry
const CapsuleRecap = pluginRegistry.__kinsphereCapsuleRecap ??=
  registerPlugin<CapsuleRecapPlugin>('CapsuleRecap')

export function isNativeCapsuleRecapAvailable(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === 'ios' &&
    Capacitor.isPluginAvailable('CapsuleRecap')
  )
}

function requireNativeCapsuleRecap() {
  if (!isNativeCapsuleRecapAvailable()) {
    throw new Error('Native capsule recap rendering is not available on this device.')
  }
}

/**
 * Stages one browser-produced image at a time. Keeping this call sequential
 * avoids passing a whole week's full-resolution photos through the bridge in
 * one JSON payload.
 */
export async function stageNativeCapsuleRecapImage(options: {
  dataUrl: string
}): Promise<StagedCapsuleRecapImage> {
  requireNativeCapsuleRecap()

  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(options.dataUrl)) {
    throw new TypeError('Capsule recap images must be base64 image data URLs.')
  }

  return CapsuleRecap.stageImage({ dataUrl: options.dataUrl })
}

/** Short alias used by the recap preparation pipeline. */
export const stageImage = stageNativeCapsuleRecapImage

/**
 * Creates a 1080x1920 H.264 MP4 at 30 fps. Each ordered image is represented
 * by exactly six frames (200 ms). Successfully consumed staged images are
 * removed by the native plugin.
 */
export async function renderNativeCapsuleRecap(options: {
  imagePaths: string[]
}): Promise<NativeCapsuleRecapResult> {
  requireNativeCapsuleRecap()

  const imagePaths = options.imagePaths.map((path) => path.trim())
  if (imagePaths.length === 0) {
    throw new TypeError('Add at least one image to create a capsule recap.')
  }
  if (imagePaths.length > 150) {
    throw new TypeError('A capsule recap can contain at most 150 images.')
  }
  if (imagePaths.some((path) => !path)) {
    throw new TypeError('Every capsule recap image must have a staged path.')
  }

  return CapsuleRecap.renderRecap({ imagePaths })
}

/** Opens the native iOS share sheet, including Save Video and AirDrop. */
export async function shareNativeCapsuleRecap(
  fileUri: string,
): Promise<NativeCapsuleRecapShareResult> {
  requireNativeCapsuleRecap()
  const normalizedFileUri = fileUri.trim()
  if (!normalizedFileUri) {
    throw new TypeError('A rendered capsule recap file is required.')
  }

  return CapsuleRecap.shareRecap({ fileUri: normalizedFileUri })
}

/** Best-effort cleanup for staging files or an unshared rendered recap. */
export async function discardNativeCapsuleRecapArtifacts(
  fileUris: string[],
): Promise<void> {
  if (!isNativeCapsuleRecapAvailable()) return
  const normalized = [...new Set(fileUris.map((value) => value.trim()).filter(Boolean))]
  if (normalized.length === 0) return
  await CapsuleRecap.discardArtifacts({ fileUris: normalized })
}
