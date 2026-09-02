import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PanoramaScene } from '../../../viewer'

type NativeCardboardPanoramaPlugin = {
  open: (options: {
    dataBase64: string
    mimeType: string
    title: string
    initialYaw: number
    initialPitch: number
  }) => Promise<{ launched?: boolean }>
}

const CardboardPanorama = registerPlugin<NativeCardboardPanoramaPlugin>(
  'CardboardPanorama',
)

// Each native plugin independently enforces the base64-encoded equivalent.
// Refusing earlier avoids materializing an oversized second copy in WebView.
export const MAX_NATIVE_CARDBOARD_IMAGE_BYTES = 36 * 1024 * 1024

/** Reports whether the current native shell exposes its panorama viewer. */
export function nativeCardboardPanoramaAvailable(): boolean {
  const platform = Capacitor.getPlatform()
  return (
    Capacitor.isNativePlatform() &&
    (platform === 'android' || platform === 'ios') &&
    Capacitor.isPluginAvailable('CardboardPanorama')
  )
}

/**
 * Copies one panorama into the native Cardboard viewer when available.
 * Returns false for any bridge or image failure so the caller can use WebGL.
 */
export async function presentNativeCardboardPanorama(options: {
  scene: PanoramaScene
  sourceBlob?: Blob | null
}): Promise<boolean> {
  if (!nativeCardboardPanoramaAvailable()) return false

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
    const result = await CardboardPanorama.open({
      dataBase64,
      mimeType: panoramaBlob.type || 'image/jpeg',
      title: options.scene.title ?? 'Family moment',
      initialYaw: options.scene.yaw ?? 0,
      initialPitch: options.scene.pitch ?? 0,
    })
    // Both native viewers are full-screen covers. Closing them simply reveals
    // the exact memory/setup state that was already underneath; neither
    // platform asks React Router to navigate on the user's behalf.
    return result.launched === true
  } catch {
    // The shared WebGL Cardboard viewer remains the no-data-loss fallback.
    return false
  }
}

/** Resolves a browser URL to owned bytes before crossing the native bridge. */
async function fetchPanoramaBlob(source: string): Promise<Blob> {
  const response = await fetch(source)
  if (!response.ok) {
    throw new Error(`Panorama request failed with ${response.status}`)
  }
  return response.blob()
}

/** Converts a borrowed Blob to the payload format expected by Capacitor. */
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
