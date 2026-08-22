import type { AuthUser } from './types'
import { clerkConfigured } from './config'

const DEVELOPMENT_PREVIEW_STORAGE_KEY =
  'kinsphere.development-preview.active.v1'

export function canUseDevelopmentPreview(
  developmentBuild: boolean,
  hasClerkConfiguration: boolean,
  _nativeApp = false,
) {
  // Native packaging alone must never unlock authentication. Android test
  // access is separately triple-gated by the debuggable APK, BuildConfig, and
  // the explicitly enabled DebugAccess plugin.
  return developmentBuild && !hasClerkConfiguration
}

export const developmentPreviewAvailable = canUseDevelopmentPreview(
  import.meta.env.DEV,
  clerkConfigured,
)

export const developmentPreviewUser: AuthUser = {
  id: 'development-preview-user',
  displayName: 'Bubble Preview',
  email: null,
  phone: null,
  imageUrl: null,
}

export function readDevelopmentPreviewSession() {
  if (!developmentPreviewAvailable || typeof window === 'undefined') {
    return false
  }
  try {
    return (
      window.sessionStorage.getItem(DEVELOPMENT_PREVIEW_STORAGE_KEY) ===
      'active'
    )
  } catch {
    return false
  }
}

export function startDevelopmentPreviewSession() {
  if (!developmentPreviewAvailable || typeof window === 'undefined') {
    return false
  }
  try {
    window.sessionStorage.setItem(
      DEVELOPMENT_PREVIEW_STORAGE_KEY,
      'active',
    )
  } catch {
    // Storage may be unavailable in a restricted web view. The in-memory
    // session still works for the current render.
  }
  return true
}

export function clearDevelopmentPreviewSession() {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(DEVELOPMENT_PREVIEW_STORAGE_KEY)
  } catch {
    // There is nothing else to clear when storage is unavailable.
  }
}
