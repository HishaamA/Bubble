import { Capacitor, registerPlugin } from '@capacitor/core'
import type { AppTheme } from './AppTheme'

export interface AppIconResult {
  status: 'updated' | 'unchanged' | 'unsupported' | 'failed'
  theme: AppTheme
}

interface AppIconPlugin {
  setTheme(options: { theme: AppTheme }): Promise<AppIconResult>
}

const AppIcon = registerPlugin<AppIconPlugin>('AppIcon')
let pendingUpdate: Promise<unknown> = Promise.resolve()

/** Serializes native icon changes so rapid selections finish on the latest theme. */
export function syncThemeAppIcon(theme: AppTheme, explicitSelection: boolean): Promise<AppIconResult> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('AppIcon')) {
    return Promise.resolve({ status: 'unsupported', theme })
  }
  // iOS presents a system confirmation when changing an icon. Never surprise
  // someone with that alert at launch, or because another browser tab changed.
  if (Capacitor.getPlatform() === 'ios' && !explicitSelection) {
    return Promise.resolve({ status: 'unchanged', theme })
  }

  const update = pendingUpdate.then(async (): Promise<AppIconResult> => {
    try {
      return await AppIcon.setTheme({ theme })
    } catch {
      // Theme selection must remain usable with older native builds and launchers
      // that cannot refresh an icon. No account or appearance data is rolled back.
      return { status: 'failed', theme }
    }
  })
  pendingUpdate = update
  return update
}

/** Browser tabs follow the same palette; installed browser shortcuts are OS-managed. */
export function updateThemeFavicon(theme: AppTheme) {
  if (typeof document === 'undefined') return
  let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!icon) {
    icon = document.createElement('link')
    icon.rel = 'icon'
    document.head.appendChild(icon)
  }
  icon.type = 'image/svg+xml'
  icon.href = `${import.meta.env.BASE_URL}icons/bubble-${theme}.svg`
}
