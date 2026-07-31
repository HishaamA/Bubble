import type { MomentChangeNotifier } from './types'

const CHANNEL_NAME = 'kinsphere-family-moments'
const STORAGE_KEY = 'kinsphere:family-moments:changed'
const contextId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

type Notification = {
  type: 'moments-changed'
  contextId: string
  nonce: string
}

type LocalListener = {
  notifierId: string
  emit: () => void
}

const localListeners = new Set<LocalListener>()

function isNotification(value: unknown): value is Notification {
  if (!value || typeof value !== 'object') return false
  return (
    'type' in value &&
    value.type === 'moments-changed' &&
    'contextId' in value &&
    typeof value.contextId === 'string'
  )
}

export function createMomentChangeNotifier(): MomentChangeNotifier {
  const listeners = new Set<() => void>()
  const notifierId = Math.random().toString(36).slice(2)
  const emit = () => listeners.forEach((listener) => listener())
  const localListener = { notifierId, emit }
  localListeners.add(localListener)

  const browserWindow = typeof window === 'undefined' ? null : window
  let channel: BroadcastChannel | null = null

  if (browserWindow && typeof browserWindow.BroadcastChannel === 'function') {
    channel = new browserWindow.BroadcastChannel(CHANNEL_NAME)
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (isNotification(event.data) && event.data.contextId !== contextId) emit()
    })
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY && event.newValue) emit()
  }
  browserWindow?.addEventListener('storage', handleStorage)

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    publish() {
      for (const local of localListeners) {
        if (local.notifierId !== notifierId) local.emit()
      }

      const notification: Notification = {
        type: 'moments-changed',
        contextId,
        nonce: `${Date.now()}-${Math.random()}`,
      }

      try {
        channel?.postMessage(notification)
      } catch {
        // The local refresh still succeeds if a browser blocks BroadcastChannel.
      }

      if (!channel && browserWindow) {
        try {
          browserWindow.localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(notification),
          )
        } catch {
          // Private browsing can deny localStorage; persistence remains usable.
        }
      }
    },

    close() {
      listeners.clear()
      localListeners.delete(localListener)
      channel?.close()
      browserWindow?.removeEventListener('storage', handleStorage)
    },
  }
}
