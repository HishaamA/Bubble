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
const appStyles = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8')

function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return channels.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
}

function contrast(foreground: string, background: string) {
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

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

  it('crops one full-viewport canvas behind the native status area and sticky Journal heading', () => {
    const finalSurfaceContract = themeStyles.slice(themeStyles.indexOf('/* Final page-surface contract'))
    const sharedCanvasRule = finalSurfaceContract.match(
      /:root\[data-bubble-theme\] \.app-viewport,\s*:root\[data-bubble-theme\] \.app-status-bar-backdrop,\s*:root\[data-bubble-theme\] \.journal-page__chrome\s*\{([^}]+)\}/,
    )?.[1]
    expect(sharedCanvasRule).toBeDefined()
    expect(sharedCanvasRule).toContain('background: var(--theme-page-background)')
    expect(sharedCanvasRule).toContain('background-size: 100% var(--app-visual-viewport-height, 100dvh)')
    expect(sharedCanvasRule).toContain('background-position: center top')
    expect(sharedCanvasRule).toContain('background-repeat: no-repeat')
    expect(finalSurfaceContract).toMatch(/\.journal-page__chrome\s*\{\s*backdrop-filter: none;/)
    expect(themeStyles).not.toContain('--theme-page-chrome')

    const statusRule = appStyles.match(/\.app-status-bar-backdrop\s*\{([^}]+)\}/)?.[1]
    expect(statusRule).toContain('height: max(env(safe-area-inset-top, 0px), var(--native-safe-area-top, 0px))')
    expect(statusRule).toContain('pointer-events: none')
    expect(statusRule).toContain('background: var(--theme-page-background,')
    expect(statusRule).toContain('background-size: 100% var(--app-visual-viewport-height, 100dvh)')
  })

  it.each(['plum', 'forest', 'midnight'])('keeps small text readable on every %s paper/card surface', (theme) => {
    const block = themeStyles.match(new RegExp(`:root\\[data-bubble-theme='${theme}'\\] \\{([^}]+)\\}`))?.[1] ?? ''
    const color = (token: string) => {
      const value = block.match(new RegExp(`--theme-${token}: (#[0-9a-f]{6});`))?.[1]
      expect(value, `missing ${theme} ${token}`).toBeDefined()
      return value!
    }
    for (const background of ['paper', 'paper-deep', 'panel', 'action']) {
      expect(contrast(color('muted'), color(background)), `${theme} muted on ${background}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color('ink'), color(background)), `${theme} ink on ${background}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
