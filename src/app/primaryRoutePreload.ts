/** The same import functions serve lazy rendering and quiet-time preloading. */
export const loadMomentsRoute = () => import('./routes/MemoriesRoutes')
export const loadJournalRoute = () => import('./routes/JournalRoutes')
export const loadCapsulesRoute = () => import('../features/capsules/CapsulesPage')

export function preloadPrimaryRoute(pathname: string): Promise<unknown> {
  if (pathname === '/') return loadMomentsRoute()
  if (pathname === '/capsule') return loadCapsulesRoute()
  if (pathname === '/journal') return loadJournalRoute()
  return Promise.resolve()
}

/** Wait until navigation settles, then warm one small route chunk at a time. */
export function schedulePrimaryRoutePreloads(
  pathname: string,
  load: (pathname: string) => Promise<unknown> = preloadPrimaryRoute,
) {
  const current = pathname.startsWith('/capsule') ? '/capsule'
    : pathname.startsWith('/journal') ? '/journal' : '/'
  const remaining = ['/', '/capsule', '/journal'].filter((route) => route !== current)
  let cancelled = false
  let timer = 0
  let idle = 0
  const schedule = () => {
    if (cancelled || remaining.length === 0) return
    timer = window.setTimeout(() => {
      if (cancelled) return
      const run = () => {
        if (cancelled || document.visibilityState === 'hidden') return
        const route = remaining.shift()
        if (!route) return
        void load(route).catch(() => undefined).then(schedule)
      }
      if (typeof window.requestIdleCallback === 'function') {
        idle = window.requestIdleCallback(run, { timeout: 1_500 })
      } else {
        run()
      }
    }, 600)
  }
  schedule()
  return () => {
    cancelled = true
    window.clearTimeout(timer)
    if (idle && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle)
  }
}
