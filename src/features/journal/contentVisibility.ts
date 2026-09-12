import { useCallback, useSyncExternalStore } from 'react'

const eventName = 'bubble:content-visibility'
const storageKey = (scope: string) => `bubble:hidden-content:v1:${encodeURIComponent(scope)}`
const empty: readonly string[] = []
const cache = new Map<string, { raw: string | null; items: readonly string[] }>()

export const capsuleVisibilityKey = (id: string) => `capsule:${id}`
export const photoVisibilityKey = (id: string, kind: 'capsule-photo' | 'journal-photo') => `${kind}:${id}`

export function hiddenContent(scope: string): readonly string[] {
  let raw: string | null = null
  try { raw = localStorage.getItem(storageKey(scope)) } catch { return cache.get(scope)?.items ?? empty }
  const previous = cache.get(scope)
  if (previous?.raw === raw) return previous.items
  let items: readonly string[] = empty
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    if (Array.isArray(parsed)) items = parsed.filter((item): item is string => typeof item === 'string')
  } catch { /* Ignore malformed display preferences, never modify source data. */ }
  cache.set(scope, { raw, items })
  return items
}

/** Personal visibility never changes the family's source photos or published recap. */
export function setContentHidden(scope: string, contentKey: string, hidden: boolean) {
  const items = new Set(hiddenContent(scope))
  if (hidden) items.add(contentKey)
  else items.delete(contentKey)
  localStorage.setItem(storageKey(scope), JSON.stringify([...items]))
  window.dispatchEvent(new Event(eventName))
  window.dispatchEvent(new Event('bubble:widget-data-changed'))
}

export function restoreHiddenContent(scope: string) {
  localStorage.removeItem(storageKey(scope))
  window.dispatchEvent(new Event(eventName))
  window.dispatchEvent(new Event('bubble:widget-data-changed'))
}

function subscribe(listener: () => void) {
  window.addEventListener(eventName, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(eventName, listener)
    window.removeEventListener('storage', listener)
  }
}

export function useHiddenContent(scope: string) {
  return useSyncExternalStore(subscribe, useCallback(() => hiddenContent(scope), [scope]), () => empty)
}
