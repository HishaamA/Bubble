import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from '@capacitor/core'
import type { OAuthTransport } from '@clerk/react/types'

export const NATIVE_OAUTH_CALLBACK_URL =
  'com.simerfamily.kinsphere://callback'

type NativeWebAuthPlugin = {
  authenticate(options: {
    url: string
    callbackUrl: string
    ephemeral?: boolean
  }): Promise<{ callbackUrl: string }>
  cancel(): Promise<{ cancelled: boolean }>
}

const NativeWebAuth = registerPlugin<NativeWebAuthPlugin>('NativeWebAuth')

class NativeOAuthCancelledError extends Error {
  readonly code = 'AUTH_CANCELLED'

  constructor() {
    super('Authentication was cancelled.')
    this.name = 'NativeOAuthCancelledError'
  }
}

function isExpectedCallbackUrl(value: string) {
  try {
    const callback = new URL(value)
    return (
      callback.protocol === 'com.simerfamily.kinsphere:' &&
      callback.hostname === 'callback' &&
      (callback.pathname === '' || callback.pathname === '/') &&
      callback.username === '' &&
      callback.password === '' &&
      callback.port === ''
    )
  } catch {
    return false
  }
}

async function closeAndroidBrowser() {
  await Browser.close().catch(() => undefined)
}

async function openAndroidOAuth(url: URL) {
  let callbackListener: PluginListenerHandle | undefined
  let browserFinishedListener: PluginListenerHandle | undefined
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let resolveCallback: ((value: { callbackUrl: string }) => void) | undefined
  let rejectCallback: ((reason: unknown) => void) | undefined

  const callbackPromise = new Promise<{ callbackUrl: string }>(
    (resolve, reject) => {
      resolveCallback = resolve
      rejectCallback = reject
    },
  )

  const resolveOnce = (callbackUrl: string) => {
    if (settled) return
    settled = true
    if (cancellationTimer) clearTimeout(cancellationTimer)
    resolveCallback?.({ callbackUrl })
  }
  const rejectOnce = (error: unknown) => {
    if (settled) return
    settled = true
    if (cancellationTimer) clearTimeout(cancellationTimer)
    rejectCallback?.(error)
  }

  try {
    callbackListener = await App.addListener('appUrlOpen', ({ url: value }) => {
      if (isExpectedCallbackUrl(value)) resolveOnce(value)
    })
    browserFinishedListener = await Browser.addListener(
      'browserFinished',
      () => {
        // Android can report the Custom Tab as finished just before Capacitor
        // dispatches the deep link. Give the callback event one turn to win.
        cancellationTimer = setTimeout(
          () => rejectOnce(new NativeOAuthCancelledError()),
          250,
        )
      },
    )

    await Browser.open({
      url: url.toString(),
      toolbarColor: '#090909',
    })
    return await callbackPromise
  } finally {
    if (cancellationTimer) clearTimeout(cancellationTimer)
    await Promise.allSettled([
      callbackListener?.remove(),
      browserFinishedListener?.remove(),
      closeAndroidBrowser(),
    ])
  }
}

async function openNativeOAuth(url: URL) {
  if (url.protocol !== 'https:') {
    throw new Error('Native OAuth can only open a secure HTTPS URL.')
  }

  if (Capacitor.getPlatform() === 'ios') {
    const result = await NativeWebAuth.authenticate({
      url: url.toString(),
      callbackUrl: NATIVE_OAUTH_CALLBACK_URL,
      ephemeral: false,
    })
    if (!isExpectedCallbackUrl(result.callbackUrl)) {
      throw new Error('The authentication service returned an invalid callback URL.')
    }
    return result
  }

  if (Capacitor.getPlatform() === 'android') {
    return openAndroidOAuth(url)
  }

  throw new Error('Native OAuth is not supported on this platform.')
}

export function isNativeOAuthPlatform() {
  return Capacitor.isNativePlatform()
}

export function createNativeOAuthTransport(): OAuthTransport | undefined {
  if (!isNativeOAuthPlatform()) return undefined

  return {
    getRedirectUrl: () => NATIVE_OAUTH_CALLBACK_URL,
    open: openNativeOAuth,
  }
}

export const nativeOAuthTransport = createNativeOAuthTransport()
