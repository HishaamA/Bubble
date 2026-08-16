const DEMO_LOGIN_STORAGE_KEY = 'kinsphere.demo-login.active.v1'

/**
 * Temporary product-level demo access requested for the KinSphere prototype.
 * Set VITE_DEMO_LOGIN_ENABLED=false for a production build that must require
 * Clerk authentication.
 */
export const demoLoginAvailable =
  import.meta.env.DEV ||
  import.meta.env.VITE_DEMO_LOGIN_ENABLED?.trim().toLowerCase() === 'true'

export function readDemoLoginSession() {
  if (!demoLoginAvailable || typeof window === 'undefined') return false

  try {
    return window.localStorage.getItem(DEMO_LOGIN_STORAGE_KEY) === 'active'
  } catch {
    return false
  }
}

export function startDemoLoginSession() {
  if (!demoLoginAvailable || typeof window === 'undefined') return false

  try {
    window.localStorage.setItem(DEMO_LOGIN_STORAGE_KEY, 'active')
  } catch {
    // Restricted web views may disable durable storage. The provider still
    // activates the demo for the current app session.
  }
  return true
}

export function clearDemoLoginSession() {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.removeItem(DEMO_LOGIN_STORAGE_KEY)
  } catch {
    // There is nothing else to clear when storage is unavailable.
  }
}
