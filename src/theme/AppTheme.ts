import { useSyncExternalStore } from 'react'

export const APP_THEME_STORAGE_KEY = 'bubble:appearance-theme:v1'

export const APP_THEMES = [
  {
    id: 'plum',
    name: 'Plum',
    description: 'Warm and familiar',
    swatches: ['#240918', '#e6b5c4', '#fff1d2'],
    browserChrome: '#180611',
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Calm and grounded',
    swatches: ['#08382f', '#a8b97d', '#f5eed6'],
    browserChrome: '#03251f',
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Deep and luminous',
    swatches: ['#07163d', '#f0b94f', '#fff0d3'],
    browserChrome: '#020a24',
  },
] as const

export type AppTheme = (typeof APP_THEMES)[number]['id']

export const DEFAULT_APP_THEME: AppTheme = 'plum'

const listeners = new Set<() => void>()

function isAppTheme(value: unknown): value is AppTheme {
  return APP_THEMES.some((theme) => theme.id === value)
}

export function readStoredAppTheme(): AppTheme {
  if (typeof window === 'undefined') return DEFAULT_APP_THEME

  try {
    const storedTheme = window.localStorage.getItem(APP_THEME_STORAGE_KEY)
    return isAppTheme(storedTheme) ? storedTheme : DEFAULT_APP_THEME
  } catch {
    return DEFAULT_APP_THEME
  }
}

let activeTheme = readStoredAppTheme()
let storageListenerInstalled = false

function updateThemeColour(theme: AppTheme) {
  if (typeof document === 'undefined') return

  const themeColour = APP_THEMES.find((option) => option.id === theme)?.browserChrome
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta && themeColour) meta.content = themeColour
}

function applyThemeToDocument(theme: AppTheme) {
  if (typeof document === 'undefined') return

  document.documentElement.dataset.bubbleTheme = theme
  updateThemeColour(theme)
}

function emitThemeChange() {
  listeners.forEach((listener) => listener())
}

function handleStoredThemeChange(event: StorageEvent) {
  if (event.key !== APP_THEME_STORAGE_KEY) return

  const nextTheme = isAppTheme(event.newValue)
    ? event.newValue
    : DEFAULT_APP_THEME
  if (nextTheme === activeTheme) return

  activeTheme = nextTheme
  applyThemeToDocument(activeTheme)
  emitThemeChange()
}

export function initializeAppTheme(): AppTheme {
  activeTheme = readStoredAppTheme()
  applyThemeToDocument(activeTheme)

  if (typeof window !== 'undefined' && !storageListenerInstalled) {
    window.addEventListener('storage', handleStoredThemeChange)
    storageListenerInstalled = true
  }

  return activeTheme
}

export function setAppTheme(theme: AppTheme) {
  activeTheme = isAppTheme(theme) ? theme : DEFAULT_APP_THEME

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(APP_THEME_STORAGE_KEY, activeTheme)
    } catch {
      // The selected theme still applies for this session when storage is blocked.
    }
  }

  applyThemeToDocument(activeTheme)
  emitThemeChange()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getActiveTheme() {
  return activeTheme
}

export function useAppTheme() {
  const theme = useSyncExternalStore(
    subscribe,
    getActiveTheme,
    () => DEFAULT_APP_THEME,
  )

  return {
    theme,
    setTheme: setAppTheme,
    themes: APP_THEMES,
  }
}
