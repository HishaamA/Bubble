import { beforeEach, describe, expect, it } from 'vitest'
import {
  NATIVE_VIEWPORT_GEOMETRY_EVENT,
  applyNativeViewportGeometry,
  installNativeViewportGeometrySync,
} from './nativeViewportGeometry'

describe('native viewport geometry', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('persists UIKit safe-area insets as root CSS variables', () => {
    applyNativeViewportGeometry({
      safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
    })

    expect(document.documentElement.style.getPropertyValue('--native-safe-area-top'))
      .toBe('59px')
    expect(document.documentElement.style.getPropertyValue('--native-safe-area-bottom'))
      .toBe('34px')
  })

  it('updates the persisted values after landscape restores to portrait', () => {
    const uninstall = installNativeViewportGeometrySync()

    window.dispatchEvent(
      new CustomEvent(NATIVE_VIEWPORT_GEOMETRY_EVENT, {
        detail: {
          safeAreaInsets: { top: 0, right: 47, bottom: 21, left: 47 },
        },
      }),
    )
    window.dispatchEvent(
      new CustomEvent(NATIVE_VIEWPORT_GEOMETRY_EVENT, {
        detail: {
          safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
        },
      }),
    )

    expect(document.documentElement.style.getPropertyValue('--native-safe-area-top'))
      .toBe('59px')
    expect(document.documentElement.style.getPropertyValue('--native-safe-area-bottom'))
      .toBe('34px')
    uninstall()
  })

  it('ignores malformed and unsafe native inset values', () => {
    document.documentElement.style.setProperty('--native-safe-area-top', '47px')

    applyNativeViewportGeometry({
      safeAreaInsets: { top: -1, bottom: Number.NaN },
    })

    expect(document.documentElement.style.getPropertyValue('--native-safe-area-top'))
      .toBe('47px')
    expect(document.documentElement.style.getPropertyValue('--native-safe-area-bottom'))
      .toBe('')
  })
})
