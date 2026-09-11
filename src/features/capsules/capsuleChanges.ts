export const CAPSULES_CHANGED_EVENT = 'bubble:capsules-changed'

/** Invalidates other views only after a durable, member-scoped local mutation. */
export function notifyLocalCapsulesChanged(cacheNamespace: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CAPSULES_CHANGED_EVENT, {
    detail: { cacheNamespace },
  }))
}
