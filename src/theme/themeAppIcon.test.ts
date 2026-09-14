import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => true),
  getPlatform: vi.fn(() => 'android'),
  isPluginAvailable: vi.fn(() => true),
  setTheme: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: native,
  registerPlugin: () => ({ setTheme: native.setTheme }),
}))

import { syncThemeAppIcon, updateThemeFavicon } from './themeAppIcon'

describe('theme app icons', () => {
  beforeEach(() => {
    native.isNativePlatform.mockReturnValue(true)
    native.getPlatform.mockReturnValue('android')
    native.isPluginAvailable.mockReturnValue(true)
    native.setTheme.mockReset().mockImplementation(async ({ theme }) => ({ status: 'updated', theme }))
    document.head.querySelectorAll('link[rel="icon"]').forEach((icon) => icon.remove())
  })

  it('matches the browser icon to all palettes without inserting duplicate links', () => {
    for (const theme of ['plum', 'forest', 'midnight'] as const) {
      updateThemeFavicon(theme)
      expect(document.querySelector('link[rel="icon"]')).toHaveAttribute('href', `/icons/bubble-${theme}.svg`)
      expect(document.querySelectorAll('link[rel="icon"]')).toHaveLength(1)
    }
  })

  it('syncs an existing Android theme without needing another settings visit', async () => {
    await expect(syncThemeAppIcon('forest', false)).resolves.toEqual({ status: 'updated', theme: 'forest' })
    expect(native.setTheme).toHaveBeenCalledWith({ theme: 'forest' })
  })

  it('never raises the iOS icon confirmation at startup', async () => {
    native.getPlatform.mockReturnValue('ios')
    await expect(syncThemeAppIcon('midnight', false)).resolves.toEqual({ status: 'unchanged', theme: 'midnight' })
    expect(native.setTheme).not.toHaveBeenCalled()
    await syncThemeAppIcon('midnight', true)
    expect(native.setTheme).toHaveBeenCalledWith({ theme: 'midnight' })
  })

  it('does not invoke a native API from browsers or older app builds', async () => {
    native.isNativePlatform.mockReturnValue(false)
    expect((await syncThemeAppIcon('forest', true)).status).toBe('unsupported')
    native.isNativePlatform.mockReturnValue(true)
    native.isPluginAvailable.mockReturnValue(false)
    expect((await syncThemeAppIcon('forest', true)).status).toBe('unsupported')
    expect(native.setTheme).not.toHaveBeenCalled()
  })

  it('recovers from native errors so later selections still work', async () => {
    native.setTheme.mockRejectedValueOnce(new Error('Unsupported launcher'))
    expect((await syncThemeAppIcon('forest', true)).status).toBe('failed')
    expect((await syncThemeAppIcon('plum', true)).status).toBe('updated')
  })

  it('serializes rapid selections rather than letting an old request win', async () => {
    let resolveFirst!: (result: { status: 'updated'; theme: 'forest' }) => void
    native.setTheme.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    const forest = syncThemeAppIcon('forest', true)
    const midnight = syncThemeAppIcon('midnight', true)
    await vi.waitFor(() => expect(native.setTheme).toHaveBeenCalledTimes(1))
    resolveFirst({ status: 'updated', theme: 'forest' })
    await Promise.all([forest, midnight])
    expect(native.setTheme.mock.calls.map(([options]) => options.theme)).toEqual(['forest', 'midnight'])
  })
})
