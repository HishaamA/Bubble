import { beforeEach, describe, expect, it } from 'vitest'
import {
  APP_THEME_STORAGE_KEY,
  DEFAULT_APP_THEME,
  initializeAppTheme,
  readStoredAppTheme,
  setAppTheme,
} from './AppTheme'

describe('AppTheme', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-bubble-theme')
    setAppTheme(DEFAULT_APP_THEME)
    window.localStorage.clear()
  })

  it('defaults to plum and applies it before the app renders', () => {
    expect(initializeAppTheme()).toBe('plum')
    expect(document.documentElement).toHaveAttribute(
      'data-bubble-theme',
      'plum',
    )
  })

  it('persists a selected colour scheme and restores it', () => {
    setAppTheme('forest')

    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe('forest')
    expect(document.documentElement).toHaveAttribute(
      'data-bubble-theme',
      'forest',
    )
    expect(readStoredAppTheme()).toBe('forest')

    document.documentElement.dataset.bubbleTheme = 'plum'
    expect(initializeAppTheme()).toBe('forest')
    expect(document.documentElement).toHaveAttribute(
      'data-bubble-theme',
      'forest',
    )
  })

  it('falls back safely when a stored scheme is no longer supported', () => {
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, 'neon')

    expect(readStoredAppTheme()).toBe('plum')
    expect(initializeAppTheme()).toBe('plum')
  })
})
