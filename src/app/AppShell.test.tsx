import { Capacitor } from '@capacitor/core'
import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AuthContext,
  type AuthContextValue,
  type AuthStatus,
} from '../features/auth/authContext'
import { AppShell } from './AppShell'

const originalVisualViewport = Object.getOwnPropertyDescriptor(
  window,
  'visualViewport',
)
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

const signedInUser = {
  id: 'user-1',
  displayName: 'Simreen',
  email: 'simreen@example.com',
  phone: null,
  imageUrl: null,
}

function authValue(status: AuthStatus): AuthContextValue {
  return {
    status,
    user: status === 'signed-in' ? signedInUser : null,
    getToken: async () => null,
    signOut: async () => undefined,
  }
}

function renderShell(
  path: string,
  children: ReactNode,
  authStatus: AuthStatus = 'signed-in',
) {
  return render(
    <AuthContext.Provider value={authValue(authStatus)}>
      <MemoryRouter initialEntries={[path]}>
        <AppShell>{children}</AppShell>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

function LocationProbe() {
  const location = useLocation()
  const state = location.state as {
    openVr?: boolean
    sourceMemoryId?: string
  } | null
  return (
    <>
      <output aria-label="Current route">
        {location.pathname}
        {location.search}
      </output>
      <output aria-label="Current route intent">
        {state?.openVr ? `open-vr:${state.sourceMemoryId ?? ''}` : ''}
      </output>
    </>
  )
}

function RouteSwitcher() {
  const location = useLocation()
  const navigate = useNavigate()
  const routes = [
    ['Moments', '/'],
    ['Journal', '/journal'],
    ['Capsule', '/capsule'],
    ['Settings', '/settings'],
    ['Panorama', '/memory/family-dinner'],
    ['Capture', '/capture?mode=manual'],
  ] as const

  return (
    <>
      <output aria-label="Current route">
        {location.pathname}
        {location.search}
      </output>
      <input aria-label="Draft title" />
      {routes.map(([label, path]) => (
        <button key={path} type="button" onClick={() => navigate(path)}>
          {label}
        </button>
      ))}
    </>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  if (originalVisualViewport) {
    Object.defineProperty(window, 'visualViewport', originalVisualViewport)
  } else {
    Reflect.deleteProperty(window, 'visualViewport')
  }
  if (originalInnerHeight) {
    Object.defineProperty(window, 'innerHeight', originalInnerHeight)
  } else {
    Reflect.deleteProperty(window, 'innerHeight')
  }
  document.documentElement.style.removeProperty('--app-visual-viewport-height')
  document.documentElement.style.removeProperty('--app-visual-viewport-offset-top')
  delete document.documentElement.dataset.keyboardOpen
  delete document.documentElement.dataset.textEntryActive
})

describe('AppShell', () => {
  it('keeps one native safe-area shell across app route changes', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
    const user = userEvent.setup()
    const { container } = renderShell('/', <RouteSwitcher />)
    const shell = container.querySelector('[data-app-shell="native"]')

    expect(shell).toHaveClass('app-viewport--native')

    for (const route of [
      'Journal',
      'Capsule',
      'Settings',
      'Panorama',
      'Capture',
      'Moments',
    ]) {
      await user.click(screen.getByRole('button', { name: route }))
      expect(container.querySelector('[data-app-shell="native"]')).toBe(shell)
    }

    expect(screen.getByLabelText('Current route')).toHaveTextContent('/')
  })

  it('publishes the current visual viewport before a member route renders', () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 844,
    })
    const visualViewport = Object.assign(new EventTarget(), {
      height: 402,
      offsetTop: 0,
      scale: 1,
    }) as unknown as VisualViewport
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    })

    renderShell('/capsule', <RouteSwitcher />)
    expect(document.documentElement).toHaveStyle(
      '--app-visual-viewport-height: 402px',
    )
    expect(document.documentElement).toHaveAttribute(
      'data-keyboard-open',
      'true',
    )
  })

  it('dismisses a focused field when switching routes', async () => {
    renderShell('/capsule', <RouteSwitcher />)
    const input = screen.getByRole('textbox', { name: 'Draft title' })
    input.focus()
    expect(document.activeElement).toBe(input)

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    await waitFor(() => expect(document.activeElement).not.toBe(input))
    expect(document.documentElement).toHaveAttribute(
      'data-keyboard-open',
      'false',
    )
  })

  it('makes the 360 upload entry point available from Memories', async () => {
    const user = userEvent.setup()
    renderShell('/', <LocationProbe />)

    await user.click(screen.getByRole('button', { name: 'Upload a 360 photo now' }))

    expect(screen.getByLabelText('Current route')).toHaveTextContent(
      '/capture?mode=manual',
    )
  })

  it('keeps the Moments shortcuts in an accessible vertical action rail', async () => {
    const user = userEvent.setup()
    renderShell('/', <LocationProbe />)

    const shortcutGroup = screen.getByRole('toolbar', {
      name: 'Moments shortcuts',
    })
    expect(shortcutGroup).toHaveAttribute('aria-orientation', 'vertical')
    const shortcuts = shortcutGroup.querySelectorAll('button')
    expect(shortcuts).toHaveLength(3)
    expect(shortcuts[0]).toHaveAccessibleName('Set up Cardboard VR')
    expect(shortcuts[1]).toHaveAccessibleName('Upload a 360 photo now')
    expect(shortcuts[2]).toHaveAccessibleName('Open settings')

    await user.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(screen.getByLabelText('Current route')).toHaveTextContent('/settings')
  })

  it('opens Cardboard setup from the first Moments shortcut', async () => {
    const user = userEvent.setup()
    renderShell('/', <LocationProbe />)

    await user.click(
      screen.getByRole('button', { name: 'Set up Cardboard VR' }),
    )

    expect(screen.getByLabelText('Current route')).toHaveTextContent(
      '/memory/dinner',
    )
    expect(screen.getByLabelText('Current route intent')).toHaveTextContent(
      'open-vr:dinner',
    )
  })

  it('hides the shortcut away from Memories', () => {
    renderShell('/capsule', 'Capsule')

    expect(
      screen.queryByRole('button', { name: 'Upload a 360 photo now' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open settings' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Set up Cardboard VR' }),
    ).not.toBeInTheDocument()
  })

  it('gives native capture a distraction-free screen with its own close control', () => {
    renderShell('/capture?mode=manual', 'Capture')

    expect(
      screen.queryByRole('navigation', { name: 'Primary navigation' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open settings' }),
    ).not.toBeInTheDocument()
  })

  it('hides primary navigation and capture controls on login', () => {
    renderShell('/login', 'Sign in')

    expect(
      screen.queryByRole('navigation', { name: 'Primary navigation' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Upload a 360 photo now' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open settings' }),
    ).not.toBeInTheDocument()
  })

  it('does not reveal app chrome while authentication is loading', () => {
    renderShell('/', 'Opening family space', 'loading')

    expect(
      screen.queryByRole('navigation', { name: 'Primary navigation' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Upload a 360 photo now' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open settings' }),
    ).not.toBeInTheDocument()
  })
})
