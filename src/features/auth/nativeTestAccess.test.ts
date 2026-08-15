import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const capacitor = vi.hoisted(() => ({
  getPlatform: vi.fn(),
  isNativePlatform: vi.fn(),
  isPluginAvailable: vi.fn(),
}))
const debugAccess = vi.hoisted(() => ({
  getStatus: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: capacitor,
  registerPlugin: vi.fn(() => debugAccess),
}))

import { isNativeTestAccessEnabled } from './nativeTestAccess'

describe('native test access', () => {
  beforeEach(() => {
    capacitor.getPlatform.mockReset().mockReturnValue('android')
    capacitor.isNativePlatform.mockReset().mockReturnValue(true)
    capacitor.isPluginAvailable.mockReset().mockReturnValue(true)
    debugAccess.getStatus.mockReset().mockResolvedValue({ enabled: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepts an enabled result from the Android native security gate', async () => {
    await expect(isNativeTestAccessEnabled()).resolves.toBe(true)
  })

  it('fails closed outside Android or when the plugin is unavailable', async () => {
    capacitor.getPlatform.mockReturnValue('web')
    await expect(isNativeTestAccessEnabled()).resolves.toBe(false)
    expect(debugAccess.getStatus).not.toHaveBeenCalled()

    capacitor.getPlatform.mockReturnValue('android')
    capacitor.isPluginAvailable.mockReturnValue(false)
    await expect(isNativeTestAccessEnabled()).resolves.toBe(false)
    expect(debugAccess.getStatus).not.toHaveBeenCalled()
  })

  it('fails closed when native validation rejects', async () => {
    debugAccess.getStatus.mockRejectedValue(new Error('bridge unavailable'))
    await expect(isNativeTestAccessEnabled()).resolves.toBe(false)
  })

  it('fails closed when native validation does not answer', async () => {
    vi.useFakeTimers()
    debugAccess.getStatus.mockReturnValue(new Promise(() => undefined))

    const result = isNativeTestAccessEnabled()
    await vi.advanceTimersByTimeAsync(1_200)

    await expect(result).resolves.toBe(false)
  })
})
