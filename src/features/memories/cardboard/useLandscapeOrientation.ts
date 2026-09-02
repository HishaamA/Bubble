import { useEffect, useState } from 'react'

/** Resolves landscape state across modern, legacy, and native WebView signals. */
export function isLandscapeOrientation(): boolean {
  if (typeof window === 'undefined') return false
  const orientationType = globalThis.screen?.orientation?.type
  if (orientationType?.startsWith('landscape')) return true

  // UIWindowScene can update the layout viewport one or two frames before
  // visualViewport / matchMedia. Accept either geometry as soon as it is wider.
  if (window.innerWidth > window.innerHeight) return true
  const viewport = window.visualViewport
  if (viewport && viewport.width > viewport.height) return true

  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(orientation: landscape)').matches
    : false
}

/** Subscribes to every browser signal that may reflect a rotation transition. */
export function useLandscapeOrientation(): boolean {
  const [landscape, setLandscape] = useState(isLandscapeOrientation)

  useEffect(() => {
    /** Re-derives orientation from all geometry sources after any signal fires. */
    const update = () => setLandscape(isLandscapeOrientation())
    // Native UIWindowScene rotation, visualViewport settling, CSS media-query
    // changes and browser resize do not arrive in a guaranteed order. Listen to
    // every available signal and derive one value instead of letting the setup
    // flow advance from whichever API happened to fire first.
    const query = typeof window.matchMedia === 'function'
      ? window.matchMedia('(orientation: landscape)')
      : undefined
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.visualViewport?.addEventListener('resize', update)
    query?.addEventListener?.('change', update)
    update()
    return () => {
      // Cardboard setup is repeatedly mounted and dismissed. Symmetric cleanup
      // avoids old setup instances advancing a future flow after rotation.
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.visualViewport?.removeEventListener('resize', update)
      query?.removeEventListener?.('change', update)
    }
  }, [])

  return landscape
}
