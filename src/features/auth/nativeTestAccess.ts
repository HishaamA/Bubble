import { Capacitor, registerPlugin } from '@capacitor/core'

type DebugAccessPlugin = {
  getStatus(): Promise<{ enabled: boolean }>
}

const DebugAccess = registerPlugin<DebugAccessPlugin>('DebugAccess')

export async function isNativeTestAccessEnabled() {
  if (
    Capacitor.getPlatform() !== 'android' ||
    !Capacitor.isNativePlatform() ||
    !Capacitor.isPluginAvailable('DebugAccess')
  ) {
    return false
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      DebugAccess.getStatus().then(({ enabled }) => enabled === true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), 1_200)
      }),
    ])
  } catch {
    return false
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
