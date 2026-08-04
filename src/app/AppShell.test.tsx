import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import {
  AuthContext,
  type AuthContextValue,
  type AuthStatus,
} from '../features/auth/authContext'
import { AppShell } from './AppShell'

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
  return <output aria-label="Current route">{location.pathname}{location.search}</output>
}

describe('AppShell', () => {
  it('makes the 360 upload entry point available from Memories', async () => {
    const user = userEvent.setup()
    renderShell('/', <LocationProbe />)

    await user.click(screen.getByRole('button', { name: 'Upload a 360 photo now' }))

    expect(screen.getByLabelText('Current route')).toHaveTextContent(
      '/capture?mode=manual',
    )
  })

  it('hides the shortcut away from Memories', () => {
    renderShell('/capsules', 'Capsules')

    expect(
      screen.queryByRole('button', { name: 'Upload a 360 photo now' }),
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
