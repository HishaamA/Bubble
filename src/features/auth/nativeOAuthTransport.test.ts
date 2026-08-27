import { beforeEach, describe, expect, it, vi } from 'vitest'

const nativeMocks = vi.hoisted(() => ({
  appUrlOpen: undefined as undefined | ((event: { url: string }) => void),
  browserFinished: undefined as undefined | (() => void),
  browserClose: vi.fn(),
  browserOpen: vi.fn(),
  native: true,
  nativeWebAuth: {
    authenticate: vi.fn(),
    cancel: vi.fn(),
  },
  platform: 'android',
  removeAppListener: vi.fn(),
  removeBrowserListener: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => nativeMocks.platform,
    isNativePlatform: () => nativeMocks.native,
  },
  registerPlugin: vi.fn(() => nativeMocks.nativeWebAuth),
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(
      async (
        eventName: string,
        listener: (event: { url: string }) => void,
      ) => {
        if (eventName === 'appUrlOpen') nativeMocks.appUrlOpen = listener
        return { remove: nativeMocks.removeAppListener }
      },
    ),
  },
}))

vi.mock('@capacitor/browser', () => ({
  Browser: {
    addListener: vi.fn(async (eventName: string, listener: () => void) => {
      if (eventName === 'browserFinished') {
        nativeMocks.browserFinished = listener
      }
      return { remove: nativeMocks.removeBrowserListener }
    }),
    close: nativeMocks.browserClose,
    open: nativeMocks.browserOpen,
  },
}))

import {
  createNativeOAuthTransport,
  NATIVE_OAUTH_CALLBACK_URL,
} from './nativeOAuthTransport'

beforeEach(() => {
  vi.clearAllMocks()
  nativeMocks.appUrlOpen = undefined
  nativeMocks.browserFinished = undefined
  nativeMocks.native = true
  nativeMocks.platform = 'android'
  nativeMocks.browserClose.mockResolvedValue(undefined)
  nativeMocks.browserOpen.mockResolvedValue(undefined)
  nativeMocks.nativeWebAuth.authenticate.mockResolvedValue({
    callbackUrl: `${NATIVE_OAUTH_CALLBACK_URL}?rotating_token_nonce=ios-token`,
  })
})

describe('native OAuth transport', () => {
  it('is disabled in an ordinary browser', () => {
    nativeMocks.native = false
    expect(createNativeOAuthTransport()).toBeUndefined()
  })

  it('uses the iOS authentication session and returns its complete callback', async () => {
    nativeMocks.platform = 'ios'
    const transport = createNativeOAuthTransport()

    await expect(
      transport?.open(new URL('https://accounts.google.com/o/oauth2/v2/auth')),
    ).resolves.toEqual({
      callbackUrl: `${NATIVE_OAUTH_CALLBACK_URL}?rotating_token_nonce=ios-token`,
    })
    expect(nativeMocks.nativeWebAuth.authenticate).toHaveBeenCalledWith({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      callbackUrl: NATIVE_OAUTH_CALLBACK_URL,
      ephemeral: false,
    })
  })

  it('waits for the exact Android deep link and always cleans up', async () => {
    const transport = createNativeOAuthTransport()
    const result = transport?.open(
      new URL('https://accounts.google.com/o/oauth2/v2/auth'),
    )

    await vi.waitFor(() => expect(nativeMocks.browserOpen).toHaveBeenCalledOnce())
    nativeMocks.appUrlOpen?.({ url: 'com.simerfamily.kinsphere://elsewhere' })
    nativeMocks.appUrlOpen?.({
      url: `${NATIVE_OAUTH_CALLBACK_URL}?rotating_token_nonce=android-token`,
    })

    await expect(result).resolves.toEqual({
      callbackUrl: `${NATIVE_OAUTH_CALLBACK_URL}?rotating_token_nonce=android-token`,
    })
    expect(nativeMocks.browserOpen).toHaveBeenCalledWith({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      toolbarColor: '#090909',
    })
    expect(nativeMocks.removeAppListener).toHaveBeenCalledOnce()
    expect(nativeMocks.removeBrowserListener).toHaveBeenCalledOnce()
    expect(nativeMocks.browserClose).toHaveBeenCalledOnce()
  })

  it('treats closing the Android browser as cancellation', async () => {
    vi.useFakeTimers()
    try {
      const transport = createNativeOAuthTransport()
      const result = transport!.open(
        new URL('https://accounts.google.com/o/oauth2/v2/auth'),
      )
      const rejection = expect(result).rejects.toMatchObject({
        code: 'AUTH_CANCELLED',
      })

      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      nativeMocks.browserFinished?.()
      await vi.advanceTimersByTimeAsync(250)

      await rejection
      expect(nativeMocks.removeAppListener).toHaveBeenCalledOnce()
      expect(nativeMocks.removeBrowserListener).toHaveBeenCalledOnce()
      expect(nativeMocks.browserClose).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an invalid callback returned by the iOS plugin', async () => {
    nativeMocks.platform = 'ios'
    nativeMocks.nativeWebAuth.authenticate.mockResolvedValue({
      callbackUrl: 'https://outside.example/callback',
    })

    await expect(
      createNativeOAuthTransport()?.open(
        new URL('https://accounts.google.com/o/oauth2/v2/auth'),
      ),
    ).rejects.toThrow('invalid callback URL')
  })

  it('never opens a non-HTTPS authentication URL', async () => {
    await expect(
      createNativeOAuthTransport()?.open(
        new URL('http://accounts.google.com/o/oauth2/v2/auth'),
      ),
    ).rejects.toThrow('secure HTTPS URL')
    expect(nativeMocks.browserOpen).not.toHaveBeenCalled()
  })
})
