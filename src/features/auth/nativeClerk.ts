import { Capacitor, registerPlugin } from '@capacitor/core'
import { Clerk } from '@clerk/clerk-js'

type ClerkRequest = RequestInit & {
  url?: URL
}

type ClerkResponse = Response | undefined

type ClerkRequestHookTarget = {
  __internal_onBeforeRequest(
    callback: (request: ClerkRequest) => Promise<void>,
  ): void
  __internal_onAfterResponse(
    callback: (
      request: ClerkRequest,
      response?: ClerkResponse,
    ) => Promise<void>,
  ): void
}

type NativeClientTokenPlugin = {
  readClientToken(): Promise<{ value: string | null }>
  writeClientToken(options: { value: string }): Promise<void>
  deleteClientToken(): Promise<void>
}

/** Durable client-token operations supplied by the native Keychain plugin. */
export type ClerkClientTokenStore = {
  get(): Promise<string | null>
  save(value: string): Promise<void>
  clear(): Promise<void>
}

const NativeWebAuth = registerPlugin<NativeClientTokenPlugin>('NativeWebAuth')

/** Adapts the native Keychain plugin to Clerk's client-token hook contract. */
export function nativeClerkClientTokenStore(): ClerkClientTokenStore {
  return {
    async get() {
      const { value } = await NativeWebAuth.readClientToken()
      return value
    },
    async save(value) {
      await NativeWebAuth.writeClientToken({ value })
    },
    async clear() {
      await NativeWebAuth.deleteClientToken()
    },
  }
}

/**
 * Adds Clerk's native request markers and persists rotated client tokens.
 * Native requests omit cookie credentials because the Keychain token is the
 * authoritative session credential inside the Capacitor web view.
 */
export function attachNativeClerkRequestHooks(
  clerkClient: ClerkRequestHookTarget,
  tokenStore: ClerkClientTokenStore,
) {
  clerkClient.__internal_onBeforeRequest(async (request) => {
    request.credentials = 'omit'

    if (request.url) {
      request.url.searchParams.set('_is_native', '1')
    }

    const headers = new Headers(request.headers)
    const clientToken = await tokenStore.get()
    if (clientToken) headers.set('authorization', clientToken)
    else headers.delete('authorization')
    headers.set('x-mobile', '1')
    request.headers = headers
  })

  clerkClient.__internal_onAfterResponse(async (_request, response) => {
    const clientToken = response?.headers.get('authorization')?.trim()
    if (clientToken) await tokenStore.save(clientToken)
  })
}

let cachedNativeClerk: Clerk | undefined
let cachedPublishableKey: string | undefined

/** Creates one cached, iOS-specific Clerk client for the active publishable key. */
export function createNativeClerk(publishableKey?: string) {
  if (!publishableKey || Capacitor.getPlatform() !== 'ios') return undefined

  if (cachedNativeClerk && cachedPublishableKey === publishableKey) {
    return cachedNativeClerk
  }

  const clerkClient = new Clerk(publishableKey)
  attachNativeClerkRequestHooks(
    clerkClient,
    nativeClerkClientTokenStore(),
  )
  cachedNativeClerk = clerkClient
  cachedPublishableKey = publishableKey
  return clerkClient
}
