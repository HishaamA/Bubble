type ClearableCache = { clear(namespace?: string): void }

const caches = new Set<ClearableCache>()
const retainCounts = new Map<string, number>()

/** One warm account/family only; never persists private media beyond the session. */
export function createMemberSessionCache<T>(options: { dispose?(value: T): void } = {}) {
  let entry: { namespace: string; value: T } | undefined
  const cache = {
    get(namespace: string): T | undefined {
      return entry?.namespace === namespace ? entry.value : undefined
    },
    set(namespace: string, value: T) {
      if (entry?.namespace === namespace && entry.value === value) return
      cache.clear()
      entry = { namespace, value }
    },
    clear(namespace?: string) {
      if (!entry || (namespace !== undefined && entry.namespace !== namespace)) return
      const previous = entry.value
      entry = undefined
      options.dispose?.(previous)
    },
  }
  caches.add(cache)
  return cache
}

/** Clears loaded data and invalidates pending work for a departing member. */
export function clearMemberSessionCaches(namespace?: string) {
  caches.forEach((cache) => cache.clear(namespace))
}

/** StrictMode's immediate replay is not a sign-out; a real departure is. */
export function retainMemberSessionCaches(namespace: string) {
  retainCounts.set(namespace, (retainCounts.get(namespace) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = Math.max(0, (retainCounts.get(namespace) ?? 1) - 1)
    retainCounts.set(namespace, remaining)
    queueMicrotask(() => {
      if (retainCounts.get(namespace) !== 0) return
      retainCounts.delete(namespace)
      clearMemberSessionCaches(namespace)
    })
  }
}
