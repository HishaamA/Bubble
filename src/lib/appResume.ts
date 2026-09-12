import { App as CapacitorApp } from '@capacitor/app'

/** Refreshes suspended family feeds on browser or iOS/Android foregrounding. */
export function subscribeToAppResume(onResume: () => void): () => void {
  let active = true
  let queued = false
  let removeNativeListener: (() => Promise<void>) | undefined

  // Mobile shells may report focus, visibility and native resume together.
  // Collapse that burst without introducing a user-visible timer delay.
  const requestResume = () => {
    if (!active || queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (active) onResume()
    })
  }
  const resumeWhenVisible = () => {
    if (document.visibilityState === 'visible') requestResume()
  }

  window.addEventListener('focus', resumeWhenVisible)
  window.addEventListener('online', resumeWhenVisible)
  document.addEventListener('visibilitychange', resumeWhenVisible)
  void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    if (isActive) requestResume()
  }).then((handle) => {
    if (active) removeNativeListener = () => handle.remove()
    else void Promise.resolve(handle.remove()).catch(() => undefined)
  }).catch(() => {
    // Browser focus/visibility/online remain available without native plugins.
  })

  return () => {
    active = false
    window.removeEventListener('focus', resumeWhenVisible)
    window.removeEventListener('online', resumeWhenVisible)
    document.removeEventListener('visibilitychange', resumeWhenVisible)
    if (removeNativeListener) void Promise.resolve(removeNativeListener()).catch(() => undefined)
  }
}
