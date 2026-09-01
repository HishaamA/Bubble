import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import type { PanoramaScene } from '../../../viewer'

type NativeCardboardPanoramaPlugin = {
  open: (options: {
    dataBase64: string
    mimeType: string
    title: string
    initialYaw: number
    initialPitch: number
  }) => Promise<{ launched?: boolean }>
  addListener: (
    eventName: 'closed',
    listener: () => void,
  ) => Promise<PluginListenerHandle>
}

const CardboardPanorama = registerPlugin<NativeCardboardPanoramaPlugin>(
  'CardboardPanorama',
)

// Each native plugin independently enforces the base64-encoded equivalent.
// Refusing earlier avoids materializing an oversized second copy in WebView.
export const MAX_NATIVE_CARDBOARD_IMAGE_BYTES = 36 * 1024 * 1024

export function nativeCardboardPanoramaAvailable(): boolean {
  const platform = Capacitor.getPlatform()
  return (
    Capacitor.isNativePlatform() &&
    (platform === 'android' || platform === 'ios') &&
    Capacitor.isPluginAvailable('CardboardPanorama')
  )
}

export async function presentNativeCardboardPanorama(options: {
  scene: PanoramaScene
  sourceBlob?: Blob | null
  onClosed?: () => void
}): Promise<boolean> {
  if (!nativeCardboardPanoramaAvailable()) return false

  let closeListener: PluginListenerHandle | undefined
  let closeNotified = false
  const removeCloseListener = async () => {
    const listener = closeListener
    closeListener = undefined
    if (!listener) return
    try {
      await listener.remove()
    } catch {
      // Listener disposal belongs to the best-effort native bridge. A stale
      // plugin handle must not turn a clean web-viewer fallback into a rejected
      // launch promise or leave the setup screen permanently busy.
    }
  }

  try {
    // sourceBlob is borrowed from the caller. When only a URL is available we
    // copy its bytes for the native plugin, but never revoke blob: URLs here:
    // the journal and the WebGL fallback may still share the same object URL.
    const panoramaBlob =
      options.sourceBlob ?? (await fetchPanoramaBlob(options.scene.panorama))
    if (
      panoramaBlob.size <= 0 ||
      panoramaBlob.size > MAX_NATIVE_CARDBOARD_IMAGE_BYTES
    ) {
      return false
    }

    const dataBase64 = await blobToBase64(panoramaBlob)
    if (Capacitor.getPlatform() === 'ios' && options.onClosed) {
      const listener = await CardboardPanorama.addListener('closed', () => {
        // Native view controllers can emit more than one lifecycle callback
        // while dismissing. Treat it as a one-shot transition so the React host
        // cannot navigate backwards twice.
        if (closeNotified) return
        closeNotified = true
        void removeCloseListener()
        options.onClosed?.()
      })
      closeListener = listener
      // Defend against a bridge that synchronously reported closure while the
      // listener registration promise was still resolving.
      if (closeNotified) await removeCloseListener()
    }

    const result = await CardboardPanorama.open({
      dataBase64,
      mimeType: panoramaBlob.type || 'image/jpeg',
      title: options.scene.title ?? 'Family moment',
      initialYaw: options.scene.yaw ?? 0,
      initialPitch: options.scene.pitch ?? 0,
    })
    const launched = result.launched === true
    if (!launched) {
      closeNotified = true
      await removeCloseListener()
    }
    return launched
  } catch {
    closeNotified = true
    await removeCloseListener()
    // The shared WebGL Cardboard viewer remains the no-data-loss fallback.
    return false
  }
}

async function fetchPanoramaBlob(source: string): Promise<Blob> {
  const response = await fetch(source)
  if (!response.ok) {
    throw new Error(`Panorama request failed with ${response.status}`)
  }
  return response.blob()
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Panorama read failed'))
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Panorama reader returned an unsupported result'))
        return
      }
      const separator = reader.result.indexOf(',')
      if (separator < 0) {
        reject(new Error('Panorama data URL is malformed'))
        return
      }
      resolve(reader.result.slice(separator + 1))
    }
    reader.readAsDataURL(blob)
  })
}
