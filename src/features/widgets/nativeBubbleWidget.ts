import { Capacitor, registerPlugin } from '@capacitor/core'
import type { BubbleWidgetSnapshot } from './widgetSnapshot'

type BubbleWidgetPlugin = {
  update(options: {
    snapshot: string
    thumbnailBase64?: string
  }): Promise<void>
  clear(): Promise<void>
}

const plugin = registerPlugin<BubbleWidgetPlugin>('BubbleWidget')
let nativeOperation = Promise.resolve()

/** Avoids loading or invoking the custom bridge in an ordinary browser. */
export function isNativeBubbleWidgetAvailable() {
  return Capacitor.isNativePlatform()
    && Capacitor.isPluginAvailable('BubbleWidget')
}

/** Publishes the exact versioned payload consumed by both native widgets. */
export async function updateNativeBubbleWidget(
  snapshot: BubbleWidgetSnapshot,
  thumbnailBase64?: string,
) {
  if (!isNativeBubbleWidgetAvailable()) return false
  const update = nativeOperation
    .catch(() => undefined)
    .then(() => plugin.update({
      snapshot: JSON.stringify(snapshot),
      ...(thumbnailBase64 ? { thumbnailBase64 } : {}),
    }))
  nativeOperation = update.catch(() => undefined)
  await update
  return true
}

/** Clears account-scoped widget data on sign-out or publisher teardown. */
export async function clearNativeBubbleWidget() {
  if (!isNativeBubbleWidgetAvailable()) return false
  const clear = nativeOperation
    .catch(() => undefined)
    .then(() => plugin.clear())
  nativeOperation = clear.catch(() => undefined)
  await clear
  return true
}
