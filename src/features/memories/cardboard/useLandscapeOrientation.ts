import { useEffect, useState } from 'react'

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

export function useLandscapeOrientation(): boolean {
  const [landscape, setLandscape] = useState(isLandscapeOrientation)

  useEffect(() => {
    const update = () => setLandscape(isLandscapeOrientation())
    const query = typeof window.matchMedia === 'function'
      ? window.matchMedia('(orientation: landscape)')
      : undefined
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.visualViewport?.addEventListener('resize', update)
    query?.addEventListener?.('change', update)
    update()
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.visualViewport?.removeEventListener('resize', update)
      query?.removeEventListener?.('change', update)
    }
  }, [])

  return landscape
}
