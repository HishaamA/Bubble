import { beforeEach, describe, expect, it, vi } from 'vitest'

const capacitor = vi.hoisted(() => ({
  isNativePlatform: vi.fn(),
  getPlatform: vi.fn(),
  isPluginAvailable: vi.fn(),
}))
const orientationPlugin = vi.hoisted(() => ({
  requestLandscape: vi.fn(),
  restoreAppOrientation: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: capacitor,
  registerPlugin: vi.fn(() => orientationPlugin),
}))

import {
  nativeCardboardOrientationAvailable,
  requestNativeCardboardLandscape,
  restoreNativeAppOrientation,
  shouldRequestCardboardDomFullscreenFallback,
} from './nativeCardboardOrientation'

describe('native Cardboard orientation', () => {
  beforeEach(() => {
    capacitor.isNativePlatform.mockReset()
    capacitor.getPlatform.mockReset()
    capacitor.isPluginAvailable.mockReset().mockReturnValue(true)
    orientationPlugin.requestLandscape.mockReset().mockResolvedValue({ immersive: true })
    orientationPlugin.restoreAppOrientation.mockReset().mockResolvedValue(undefined)
  })

  it.each(['ios', 'android'])('uses the custom orientation bridge in the native %s app', async (platform) => {
    capacitor.isNativePlatform.mockReturnValue(true)
    capacitor.getPlatform.mockReturnValue(platform)

    expect(nativeCardboardOrientationAvailable()).toBe(true)
    await expect(requestNativeCardboardLandscape()).resolves.toBe(true)
    await expect(restoreNativeAppOrientation()).resolves.toBe(true)
    expect(orientationPlugin.requestLandscape).toHaveBeenCalledOnce()
    expect(orientationPlugin.restoreAppOrientation).toHaveBeenCalledOnce()
  })

  it('does not invoke an unavailable Android bridge', async () => {
    capacitor.isNativePlatform.mockReturnValue(true)
    capacitor.getPlatform.mockReturnValue('android')
    capacitor.isPluginAvailable.mockReturnValue(false)

    expect(nativeCardboardOrientationAvailable()).toBe(false)
    await expect(requestNativeCardboardLandscape()).resolves.toBe(false)
    await expect(restoreNativeAppOrientation()).resolves.toBe(false)
    expect(orientationPlugin.requestLandscape).not.toHaveBeenCalled()
    expect(orientationPlugin.restoreAppOrientation).not.toHaveBeenCalled()
  })

  it('does not report Android immersive mode from plugin presence alone', async () => {
    capacitor.isNativePlatform.mockReturnValue(true)
    capacitor.getPlatform.mockReturnValue('android')
    orientationPlugin.requestLandscape.mockResolvedValue({ orientation: 'landscape' })

    await expect(requestNativeCardboardLandscape()).resolves.toBe(false)
  })

  it('requests the gesture-bound DOM fallback only in the native Android app', () => {
    capacitor.isNativePlatform.mockReturnValue(true)
    capacitor.getPlatform.mockReturnValue('android')
    expect(shouldRequestCardboardDomFullscreenFallback()).toBe(true)

    capacitor.getPlatform.mockReturnValue('ios')
    expect(shouldRequestCardboardDomFullscreenFallback()).toBe(false)
  })

  it('does not invoke the native plugin from the web app', async () => {
    capacitor.isNativePlatform.mockReturnValue(false)
    capacitor.getPlatform.mockReturnValue('web')

    expect(nativeCardboardOrientationAvailable()).toBe(false)
    await expect(requestNativeCardboardLandscape()).resolves.toBe(false)
    await expect(restoreNativeAppOrientation()).resolves.toBe(false)
    expect(orientationPlugin.requestLandscape).not.toHaveBeenCalled()
    expect(orientationPlugin.restoreAppOrientation).not.toHaveBeenCalled()
  })

  it('fails safely if the native bridge rejects an orientation request', async () => {
    capacitor.isNativePlatform.mockReturnValue(true)
    capacitor.getPlatform.mockReturnValue('ios')
    orientationPlugin.requestLandscape.mockRejectedValue(new Error('busy'))
    orientationPlugin.restoreAppOrientation.mockRejectedValue(new Error('busy'))

    await expect(requestNativeCardboardLandscape()).resolves.toBe(false)
    await expect(restoreNativeAppOrientation()).resolves.toBe(false)
  })
})
