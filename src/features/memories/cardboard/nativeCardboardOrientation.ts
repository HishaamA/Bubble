import { Capacitor, registerPlugin } from '@capacitor/core'

type CardboardOrientationPlugin = {
  requestLandscape: () => Promise<{
    orientation?: string
    immersive?: boolean
  } | void>
  restoreAppOrientation: () => Promise<{ orientation?: string } | void>
}

const CardboardOrientation = registerPlugin<CardboardOrientationPlugin>(
  'CardboardOrientation',
)

export function nativeCardboardOrientationAvailable(): boolean {
  const platform = Capacitor.getPlatform()
  return (
    Capacitor.isNativePlatform() &&
    (platform === 'ios' || platform === 'android') &&
    Capacitor.isPluginAvailable('CardboardOrientation')
  )
}

/** Android can request DOM fullscreen during the same tap as a native backup. */
export function shouldRequestCardboardDomFullscreenFallback(): boolean {
  return nativeCardboardOrientationAvailable() && Capacitor.getPlatform() === 'android'
}

export async function requestNativeCardboardLandscape(): Promise<boolean> {
  if (!nativeCardboardOrientationAvailable()) return false

  try {
    const result = await CardboardOrientation.requestLandscape()
    // Android supplies an explicit immersive result because plugin presence
    // alone does not prove that system bars and cutout layout were applied.
    return Capacitor.getPlatform() !== 'android' || result?.immersive === true
  } catch {
    return false
  }
}

export async function restoreNativeAppOrientation(): Promise<boolean> {
  if (!nativeCardboardOrientationAvailable()) return false

  try {
    await CardboardOrientation.restoreAppOrientation()
    return true
  } catch {
    return false
  }
}
