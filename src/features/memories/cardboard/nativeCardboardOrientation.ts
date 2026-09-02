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

/** Reports whether this native build installed the orientation bridge. */
export function nativeCardboardOrientationAvailable(): boolean {
  const platform = Capacitor.getPlatform()
  return (
    Capacitor.isNativePlatform() &&
    (platform === 'ios' || platform === 'android') &&
    Capacitor.isPluginAvailable('CardboardOrientation')
  )
}

/**
 * Android can request DOM fullscreen during the same tap as a native backup.
 * Unlike iOS, the Android bridge may be installed yet report that immersive
 * system-bar handling failed, so plugin availability is not enough to suppress
 * the standards-based browser path.
 */
export function shouldRequestCardboardDomFullscreenFallback(): boolean {
  return nativeCardboardOrientationAvailable() && Capacitor.getPlatform() === 'android'
}

/** Requests native landscape/immersive presentation without throwing to UI. */
export async function requestNativeCardboardLandscape(): Promise<boolean> {
  if (!nativeCardboardOrientationAvailable()) return false

  try {
    const result = await CardboardOrientation.requestLandscape()
    // Android supplies an explicit immersive result because plugin presence
    // alone does not prove that system bars and cutout layout were applied.
    // iOS owns rotation through its presented controller, so a resolved request
    // is sufficient even though it has no DOM fullscreen element to inspect.
    return Capacitor.getPlatform() !== 'android' || result?.immersive === true
  } catch {
    return false
  }
}

/** Restores the orientation policy captured by the native bridge on entry. */
export async function restoreNativeAppOrientation(): Promise<boolean> {
  if (!nativeCardboardOrientationAvailable()) return false

  try {
    // Restoration is deliberately paired with every exit / unmount by the
    // Cardboard host. The plugin records the app's prior orientation policy;
    // guessing "portrait" here would override tablets or apps that entered VR
    // from an already-landscape screen.
    await CardboardOrientation.restoreAppOrientation()
    return true
  } catch {
    return false
  }
}
