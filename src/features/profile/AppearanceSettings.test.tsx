import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  APP_THEMES,
  APP_THEME_STORAGE_KEY,
  initializeAppTheme,
  setAppTheme,
} from '../../theme/AppTheme'
import { AppearanceSettings } from './AppearanceSettings'

describe('AppearanceSettings', () => {
  beforeEach(() => {
    window.localStorage.removeItem(APP_THEME_STORAGE_KEY)
    initializeAppTheme()
  })

  afterEach(() => {
    cleanup()
    setAppTheme('plum')
    window.localStorage.removeItem(APP_THEME_STORAGE_KEY)
  })

  it('switches all three themes with a single selected radio and persists each choice', async () => {
    const user = userEvent.setup()
    render(<AppearanceSettings />)

    expect(screen.getByRole('radiogroup', { name: 'Appearance' })).toBeVisible()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name: 'Plum: Warm and familiar' })).toHaveAttribute('aria-checked', 'true')

    for (const id of ['forest', 'midnight', 'plum'] as const) {
      const choice = APP_THEMES.find((theme) => theme.id === id)!
      await user.click(screen.getByRole('radio', { name: `${choice.name}: ${choice.description}` }))

      for (const theme of APP_THEMES) {
        expect(screen.getByRole('radio', { name: `${theme.name}: ${theme.description}` }))
          .toHaveAttribute('aria-checked', String(theme.id === id))
      }
      expect(document.documentElement).toHaveAttribute('data-bubble-theme', id)
      expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe(id)
    }
  })

  it('restores the selected appearance from storage after remount and initialization', async () => {
    const user = userEvent.setup()
    const first = render(<AppearanceSettings />)
    await user.click(screen.getByRole('radio', { name: 'Midnight: Deep and luminous' }))
    first.unmount()

    initializeAppTheme()
    render(<AppearanceSettings />)
    expect(screen.getByRole('radio', { name: 'Midnight: Deep and luminous' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Plum: Warm and familiar' })).toHaveAttribute('aria-checked', 'false')
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe('midnight')
  })
})
