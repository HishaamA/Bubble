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

export type ClerkClientTokenStore = {
  get(): Promise<string | null>
  save(value: string): Promise<void>
  clear(): Promise<void>
}

const NativeWebAuth = registerPlugin<NativeClientTokenPlugin>('NativeWebAuth')

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

export function attachNativeClerkRequestHooks(
  clerk: ClerkRequestHookTarget,
  tokenStore: ClerkClientTokenStore,
) {
  clerk.__internal_onBeforeRequest(async (request) => {
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

  clerk.__internal_onAfterResponse(async (_request, response) => {
    const clientToken = response?.headers.get('authorization')?.trim()
    if (clientToken) await tokenStore.save(clientToken)
  })
}

let nativeClerk: Clerk | undefined
let nativeClerkPublishableKey: string | undefined

export function createNativeClerk(publishableKey?: string) {
  if (!publishableKey || Capacitor.getPlatform() !== 'ios') return undefined

  if (nativeClerk && nativeClerkPublishableKey === publishableKey) {
    return nativeClerk
  }

  const clerk = new Clerk(publishableKey)
  attachNativeClerkRequestHooks(clerk, nativeClerkClientTokenStore())
  nativeClerk = clerk
  nativeClerkPublishableKey = publishableKey
  return clerk
}
