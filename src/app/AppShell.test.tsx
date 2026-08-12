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
  return (
    <output aria-label="Current route">
      {location.pathname}
      {location.search}
    </output>
  )
}

function RouteSwitcher() {
  const location = useLocation()
  const navigate = useNavigate()
  const routes = [
    ['Moments', '/'],
    ['Journal', '/journal'],
    ['Capsule', '/capsule'],
    ['Profile', '/profile'],
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
      'Profile',
      'Panorama',
      'Capture',
      'Moments',
    ]) {
      await user.click(screen.getByRole('button', { name: route }))
      expect(container.querySelector('[data-app-shell="native"]')).toBe(shell)
    }

    expect(screen.getByLabelText('Current route')).toHaveTextContent('/')
  })

  it('uses the visual viewport while the iPhone keyboard is open and restores it', () => {
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

    const { container } = renderShell('/capsule', <RouteSwitcher />)
    const shell = container.querySelector<HTMLElement>('.app-viewport')
    expect(shell).toHaveStyle('--app-visual-viewport-height: 402px')
    expect(shell).toHaveAttribute('data-keyboard-open', 'true')

    Object.assign(visualViewport, { height: 844 })
    visualViewport.dispatchEvent(new Event('resize'))
    expect(shell).toHaveStyle('--app-visual-viewport-height: 844px')
    expect(shell).toHaveAttribute('data-keyboard-open', 'false')
  })

  it('dismisses a focused field when switching routes', async () => {
    const { container } = renderShell('/capsule', <RouteSwitcher />)
    const input = screen.getByRole('textbox', { name: 'Draft title' })
    input.focus()
    expect(document.activeElement).toBe(input)

    fireEvent.click(screen.getByRole('button', { name: 'Profile' }))

    await waitFor(() => expect(document.activeElement).not.toBe(input))
    expect(container.querySelector('.app-viewport')).toHaveAttribute(
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

  it('hides the shortcut away from Memories', () => {
    renderShell('/capsule', 'Capsule')

    expect(
      screen.queryByRole('button', { name: 'Upload a 360 photo now' }),
    ).not.toBeInTheDocument()
  })

  it('gives native capture a distraction-free screen with its own close control', () => {
    renderShell('/capture?mode=manual', 'Capture')

    expect(
      screen.queryByRole('navigation', { name: 'Primary navigation' }),
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
  })

  it('does not reveal app chrome while authentication is loading', () => {
    renderShell('/', 'Opening family space', 'loading')

    expect(
      screen.queryByRole('navigation', { name: 'Primary navigation' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Upload a 360 photo now' }),
    ).not.toBeInTheDocument()
  })
})
