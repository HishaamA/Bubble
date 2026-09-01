import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  APP_THEME_STORAGE_KEY,
  DEFAULT_APP_THEME,
  initializeAppTheme,
  readStoredAppTheme,
  setAppTheme,
} from './AppTheme'

const themeStyles = readFileSync(
  join(process.cwd(), 'src/theme/AppTheme.css'),
  'utf8',
)

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

  it('keeps every primary route on the shared selected-theme canvas', () => {
    const finalSurfaceContract = themeStyles.slice(
      themeStyles.indexOf('/* Final page-surface contract'),
    )

    expect(finalSurfaceContract).toContain('.app-viewport')
    expect(finalSurfaceContract).toContain('.memories-screen')
    expect(finalSurfaceContract).toContain('.capsules-page')
    expect(finalSurfaceContract).toContain('.journal-page')
    expect(finalSurfaceContract).toContain('.person-scrapbook')
    expect(finalSurfaceContract).toContain('.profile-page')
    expect(finalSurfaceContract).toContain('.capture-page')
    expect(finalSurfaceContract).toContain('background-image: none')
    expect(finalSurfaceContract).toContain('var(--theme-action) 54%')
  })
})
