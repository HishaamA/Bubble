import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from '@capacitor/core'
import type { OAuthTransport } from '@clerk/react/types'

/** Deep link registered by both native platforms for OAuth completion. */
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

/** Normalizes native browser dismissal to the cancellation code used by the UI. */
class NativeOAuthCancelledError extends Error {
  readonly code = 'AUTH_CANCELLED'

  constructor() {
    super('Authentication was cancelled.')
    this.name = 'NativeOAuthCancelledError'
  }
}

/** Accepts only Bubble's exact callback authority while allowing query results. */
function isExpectedCallbackUrl(callbackUrl: string) {
  try {
    const callback = new URL(callbackUrl)
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

/** Best-effort cleanup for Custom Tabs that may already have dismissed themselves. */
async function closeAndroidBrowser() {
  await Browser.close().catch(() => undefined)
}

/** Owns the Android Custom Tab and races its deep link against user dismissal. */
async function openAndroidOAuth(authorizationUrl: URL) {
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
    callbackListener = await App.addListener(
      'appUrlOpen',
      ({ url: callbackUrl }) => {
        if (isExpectedCallbackUrl(callbackUrl)) resolveOnce(callbackUrl)
      },
    )
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
      url: authorizationUrl.toString(),
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

/** Opens a secure authorization URL with the platform-appropriate native UI. */
async function openNativeOAuth(authorizationUrl: URL) {
  if (authorizationUrl.protocol !== 'https:') {
    throw new Error('Native OAuth can only open a secure HTTPS URL.')
  }

  if (Capacitor.getPlatform() === 'ios') {
    const authenticationResult = await NativeWebAuth.authenticate({
      url: authorizationUrl.toString(),
      callbackUrl: NATIVE_OAUTH_CALLBACK_URL,
      ephemeral: false,
    })
    if (!isExpectedCallbackUrl(authenticationResult.callbackUrl)) {
      throw new Error(
        'The authentication service returned an invalid callback URL.',
      )
    }
    return authenticationResult
  }

  if (Capacitor.getPlatform() === 'android') {
    return openAndroidOAuth(authorizationUrl)
  }

  throw new Error('Native OAuth is not supported on this platform.')
}

/** Reports whether Clerk should use the native OAuth transport. */
export function isNativeOAuthPlatform() {
  return Capacitor.isNativePlatform()
}

/** Builds Clerk's OAuth transport only inside a native Capacitor app. */
export function createNativeOAuthTransport(): OAuthTransport | undefined {
  if (!isNativeOAuthPlatform()) return undefined

  return {
    getRedirectUrl: () => NATIVE_OAUTH_CALLBACK_URL,
    open: openNativeOAuth,
  }
}

/** Runtime OAuth transport supplied to Clerk, or undefined for browser flows. */
export const nativeOAuthTransport = createNativeOAuthTransport()
