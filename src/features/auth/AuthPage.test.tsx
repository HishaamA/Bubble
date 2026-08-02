import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthPage } from './AuthPage'
import { AuthProvider, RequireAuthentication } from './AuthProvider'
import type { AuthContextValue } from './authContext'
import type { AuthUser } from './types'

vi.mock('@clerk/react', () => ({
  SignInButton: ({ children, mode }: { children: ReactNode; mode: string }) => (
    <div data-testid="clerk-sign-in" data-mode={mode}>{children}</div>
  ),
  SignUpButton: ({ children, mode }: { children: ReactNode; mode: string }) => (
    <div data-testid="clerk-sign-up" data-mode={mode}>{children}</div>
  ),
  useAuth: vi.fn(),
  useClerk: vi.fn(),
  useUser: vi.fn(),
}))

const signedInUser: AuthUser = {
  id: 'user_1',
  displayName: 'Simreen',
  email: 'simreen@example.com',
  phone: null,
  imageUrl: 'https://images.example/simreen.jpg',
}

function authValue(
  status: AuthContextValue['status'],
  user: AuthUser | null = null,
): AuthContextValue {
  return {
    status,
    user,
    getToken: vi.fn(async () => null),
    signOut: vi.fn(async () => undefined),
  }
}

function LoginDestination() {
  const location = useLocation()
  const returnTo = (location.state as { returnTo?: string } | null)?.returnTo
  return <output aria-label="Requested return route">{returnTo}</output>
}

afterEach(() => {
  window.sessionStorage.clear()
})

describe('AuthPage', () => {
  it('fails closed with explicit setup guidance when Clerk is missing', () => {
    render(
      <AuthProvider value={authValue('unconfigured')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    expect(screen.getByText('Clerk connection required')).toBeInTheDocument()
    expect(screen.getByText('VITE_CLERK_PUBLISHABLE_KEY')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(screen.queryByText(/local preview/i)).not.toBeInTheDocument()
  })

  it('uses Clerk modal controls and preserves a safe return route', async () => {
    const user = userEvent.setup()
    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter
          initialEntries={[
            { pathname: '/login', state: { returnTo: '/journal?view=list' } },
          ]}
        >
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    expect(screen.getByTestId('clerk-sign-in')).toHaveAttribute('data-mode', 'modal')
    expect(screen.getByTestId('clerk-sign-up')).toHaveAttribute('data-mode', 'modal')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(window.sessionStorage.getItem('kinsphere.auth.returnTo')).toBe(
      '/journal?view=list',
    )
  })

  it('restores and clears the return route after Clerk signs in', async () => {
    window.sessionStorage.setItem('kinsphere.auth.returnTo', '/journal')
    render(
      <AuthProvider value={authValue('signed-in', signedInUser)}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<AuthPage />} />
            <Route path="/journal" element={<p>Restored journal</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    )

    expect(await screen.findByText('Restored journal')).toBeInTheDocument()
    expect(window.sessionStorage.getItem('kinsphere.auth.returnTo')).toBeNull()
  })

  it('rejects an external return route', async () => {
    window.sessionStorage.setItem(
      'kinsphere.auth.returnTo',
      '//outside.example/family',
    )
    render(
      <AuthProvider value={authValue('signed-in', signedInUser)}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<AuthPage />} />
            <Route path="/" element={<p>Safe home</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    )

    expect(await screen.findByText('Safe home')).toBeInTheDocument()
  })

  it.each(['signed-out', 'unconfigured'] as const)(
    'redirects %s users to login and preserves the private route',
    async (status) => {
      render(
        <AuthProvider value={authValue(status)}>
          <MemoryRouter initialEntries={['/events?view=week']}>
            <Routes>
              <Route path="/login" element={<LoginDestination />} />
              <Route element={<RequireAuthentication />}>
                <Route path="/events" element={<p>Private events</p>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AuthProvider>,
      )

      expect(
        await screen.findByLabelText('Requested return route'),
      ).toHaveTextContent('/events?view=week')
      expect(screen.queryByText('Private events')).not.toBeInTheDocument()
    },
  )
})
