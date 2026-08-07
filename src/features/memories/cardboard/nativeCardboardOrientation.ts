import { Capacitor, registerPlugin } from '@capacitor/core'

type CardboardOrientationPlugin = {
  requestLandscape: () => Promise<{ orientation?: string } | void>
  restoreAppOrientation: () => Promise<{ orientation?: string } | void>
}

const CardboardOrientation = registerPlugin<CardboardOrientationPlugin>(
  'CardboardOrientation',
)

export function nativeCardboardOrientationAvailable(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === 'ios' &&
    Capacitor.isPluginAvailable('CardboardOrientation')
  )
}

export async function requestNativeCardboardLandscape(): Promise<boolean> {
  if (!nativeCardboardOrientationAvailable()) return false

  try {
    await CardboardOrientation.requestLandscape()
    return true
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
