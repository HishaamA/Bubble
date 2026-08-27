import { describe, expect, it, vi } from 'vitest'
import {
  attachNativeClerkRequestHooks,
  type ClerkClientTokenStore,
} from './nativeClerk'

function createHarness(token: string | null = null) {
  let beforeRequest:
    | ((request: RequestInit & { url?: URL }) => Promise<void>)
    | undefined
  let afterResponse:
    | ((
        request: RequestInit & { url?: URL },
        response?: Response,
      ) => Promise<void>)
    | undefined

  const store: ClerkClientTokenStore = {
    get: vi.fn(async () => token),
    save: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  }

  attachNativeClerkRequestHooks(
    {
      __internal_onBeforeRequest(callback) {
        beforeRequest = callback
      },
      __internal_onAfterResponse(callback) {
        afterResponse = callback
      },
    },
    store,
  )

  return {
    beforeRequest: () => {
      if (!beforeRequest) throw new Error('Missing before-request hook')
      return beforeRequest
    },
    afterResponse: () => {
      if (!afterResponse) throw new Error('Missing after-response hook')
      return afterResponse
    },
    store,
  }
}

describe('native Clerk requests', () => {
  it('marks the request as native and sends the raw cached client token', async () => {
    const harness = createHarness('native-client-jwt')
    const request = {
      credentials: 'include' as RequestCredentials,
      headers: new Headers({ authorization: 'stale' }),
      url: new URL('https://example.clerk.accounts.dev/v1/client?_is_native=0'),
    }

    await harness.beforeRequest()(request)

    expect(request.credentials).toBe('omit')
    expect(request.url.searchParams.getAll('_is_native')).toEqual(['1'])
    expect(request.headers.get('authorization')).toBe('native-client-jwt')
    expect(request.headers.get('x-mobile')).toBe('1')
  })

  it('does not reuse an authorization header when the Keychain is empty', async () => {
    const harness = createHarness()
    const request = {
      headers: new Headers({ authorization: 'stale' }),
      url: new URL('https://example.clerk.accounts.dev/v1/environment'),
    }

    await harness.beforeRequest()(request)

    expect(request.headers.has('authorization')).toBe(false)
  })

  it('persists Clerk client-token rotation after every response', async () => {
    const harness = createHarness()
    const response = new Response(null, {
      headers: { authorization: 'rotated-client-jwt' },
    })

    await harness.afterResponse()({}, response)

    expect(harness.store.save).toHaveBeenCalledWith('rotated-client-jwt')
  })
})
