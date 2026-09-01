import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthPage } from './AuthPage'
import { AuthProvider, RequireAuthentication } from './AuthProvider'
import type { AuthContextValue } from './authContext'
import type { AuthUser } from './types'

const authPlatformMocks = vi.hoisted(() => ({ native: false }))

const clerkMocks = vi.hoisted(() => ({
  signIn: {
    status: 'needs_first_factor',
    isTransferable: false,
    existingSession: undefined as { sessionId: string } | undefined,
    supportedSecondFactors: [] as Array<{
      strategy: string
      safeIdentifier?: string
    }>,
    create: vi.fn(),
    sso: vi.fn(),
    emailCode: {
      sendCode: vi.fn(),
      verifyCode: vi.fn(),
    },
    mfa: {
      sendEmailCode: vi.fn(),
      verifyEmailCode: vi.fn(),
    },
    finalize: vi.fn(),
    reset: vi.fn(),
  },
  signUp: {
    status: 'missing_requirements',
    missingFields: [] as string[],
    create: vi.fn(),
    finalize: vi.fn(),
    reset: vi.fn(),
  },
  client: {
    lastActiveSessionId: null as string | null,
    sessions: [] as Array<{ id: string }>,
    signedInSessions: [] as Array<{
      id: string
      status?: 'active' | 'pending'
      user: null | {
        emailAddresses: Array<{ emailAddress: string }>
      }
    }>,
    reload: vi.fn(),
    signIn: {
      authenticateWithRedirect: vi.fn(),
    },
  },
  setActive: vi.fn(),
}))

vi.mock('./nativeOAuthTransport', () => ({
  isNativeOAuthPlatform: () => authPlatformMocks.native,
  NATIVE_OAUTH_CALLBACK_URL: 'com.simerfamily.kinsphere://callback',
}))

vi.mock('@clerk/react', () => ({
  useSignIn: () => ({
    signIn: clerkMocks.signIn,
    errors: { fields: {} },
    fetchStatus: 'idle',
  }),
  useSignUp: () => ({
    signUp: clerkMocks.signUp,
    errors: { fields: {} },
    fetchStatus: 'idle',
  }),
  useAuth: vi.fn(),
  useClerk: () => ({
    client: clerkMocks.client,
    setActive: clerkMocks.setActive,
  }),
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

beforeEach(() => {
  vi.clearAllMocks()
  authPlatformMocks.native = false
  clerkMocks.signIn.status = 'needs_first_factor'
  clerkMocks.signIn.isTransferable = false
  clerkMocks.signIn.existingSession = undefined
  clerkMocks.signIn.supportedSecondFactors = []
  clerkMocks.signUp.status = 'missing_requirements'
  clerkMocks.signUp.missingFields = []
  clerkMocks.client.lastActiveSessionId = null
  clerkMocks.client.sessions = []
  clerkMocks.client.signedInSessions = []
  clerkMocks.client.reload.mockResolvedValue(clerkMocks.client)
  clerkMocks.client.signIn.authenticateWithRedirect.mockResolvedValue(undefined)
  clerkMocks.signIn.create.mockResolvedValue({ error: null })
  clerkMocks.signIn.sso.mockResolvedValue({ error: null })
  clerkMocks.signIn.emailCode.sendCode.mockResolvedValue({ error: null })
  clerkMocks.signIn.emailCode.verifyCode.mockResolvedValue({ error: null })
  clerkMocks.signIn.mfa.sendEmailCode.mockResolvedValue({ error: null })
  clerkMocks.signIn.mfa.verifyEmailCode.mockResolvedValue({ error: null })
  clerkMocks.signIn.finalize.mockResolvedValue({ error: null })
  clerkMocks.signIn.reset.mockResolvedValue({ error: null })
  clerkMocks.signUp.create.mockResolvedValue({ error: null })
  clerkMocks.signUp.finalize.mockResolvedValue({ error: null })
  clerkMocks.signUp.reset.mockResolvedValue({ error: null })
  clerkMocks.setActive.mockResolvedValue(undefined)
})

afterEach(() => {
  window.sessionStorage.clear()
  vi.restoreAllMocks()
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

  it('opens Google and email choices inside the app', async () => {
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

    await user.click(screen.getByRole('button', { name: 'Get started' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Choose how to continue' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    expect(screen.queryByLabelText(/phone/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/development mode/i)).not.toBeInTheDocument()
    expect(window.sessionStorage.getItem('kinsphere.auth.returnTo')).toBeNull()
  })

  it('contains keyboard focus, closes with Escape, and restores the opener even if Clerk reset fails', async () => {
    const user = userEvent.setup()
    clerkMocks.signIn.reset.mockRejectedValueOnce(new Error('offline'))
    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    const opener = screen.getByRole('button', { name: 'Get started' })
    await user.click(opener)
    const dialog = screen.getByRole('dialog')
    const closeButton = within(dialog).getByRole('button', {
      name: 'Close sign in',
    })
    const lastFocusable = within(dialog).getByLabelText('Email address')

    closeButton.focus()
    await user.tab({ shift: true })
    expect(lastFocusable).toHaveFocus()
    await user.tab()
    expect(closeButton).toHaveFocus()

    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )
    expect(opener).toHaveFocus()
    expect(clerkMocks.signIn.reset).toHaveBeenCalledOnce()
    expect(clerkMocks.signUp.reset).toHaveBeenCalledOnce()
  })

  it('uses a Google popup, preserves the return route, and finalizes sign-in', async () => {
    const user = userEvent.setup()
    const popupState = { closed: false }
    const popup = {
      get closed() {
        return popupState.closed
      },
      close: vi.fn(() => {
        popupState.closed = true
      }),
      location: { href: 'about:blank' },
    } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(popup)
    clerkMocks.signIn.sso.mockImplementation(async () => {
      clerkMocks.signIn.status = 'complete'
      return { error: null }
    })

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

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))

    await waitFor(() => expect(clerkMocks.signIn.finalize).toHaveBeenCalledOnce())
    expect(clerkMocks.signIn.sso).toHaveBeenCalledWith({
      strategy: 'oauth_google',
      redirectCallbackUrl: expect.stringMatching(/\/#\/login$/),
      redirectUrl: expect.stringMatching(/\/#\/login$/),
      popup,
    })
    expect(window.sessionStorage.getItem('kinsphere.auth.returnTo')).toBe(
      '/journal?view=list',
    )
    expect(popup.close).toHaveBeenCalledOnce()
  })

  it('returns to the sign-in choices when Google is cancelled', async () => {
    const user = userEvent.setup()
    const popupState = { closed: false }
    const popup = {
      get closed() {
        return popupState.closed
      },
      close: vi.fn(() => {
        popupState.closed = true
      }),
      location: { href: 'about:blank' },
    } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(popup)
    clerkMocks.signIn.sso.mockRejectedValue({ code: 'AUTH_CANCELLED' })

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Continue with Google' }),
      ).toBeEnabled(),
    )
    expect(screen.queryByText(/could not complete/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toBeEnabled()
  })

  it('transfers a new Google identity into sign-up and finalizes it', async () => {
    const user = userEvent.setup()
    const popupState = { closed: false }
    const popup = {
      get closed() {
        return popupState.closed
      },
      close: vi.fn(() => {
        popupState.closed = true
      }),
      location: { href: 'about:blank' },
    } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(popup)
    clerkMocks.signIn.sso.mockImplementation(async () => {
      clerkMocks.signIn.isTransferable = true
      return { error: null }
    })
    clerkMocks.signUp.create.mockImplementation(async () => {
      clerkMocks.signUp.status = 'complete'
      return { error: null }
    })

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))

    await waitFor(() => expect(clerkMocks.signUp.finalize).toHaveBeenCalledOnce())
    expect(clerkMocks.signUp.create).toHaveBeenCalledWith({ transfer: true })
  })

  it('shows Clerk\'s masked email destination for Google MFA', async () => {
    const user = userEvent.setup()
    const popupState = { closed: false }
    const popup = {
      get closed() {
        return popupState.closed
      },
      close: vi.fn(() => {
        popupState.closed = true
      }),
      location: { href: 'about:blank' },
    } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(popup)
    clerkMocks.signIn.supportedSecondFactors = [
      { strategy: 'email_code', safeIdentifier: 's***@example.com' },
    ]
    clerkMocks.signIn.sso.mockImplementation(async () => {
      clerkMocks.signIn.status = 'needs_second_factor'
      return { error: null }
    })

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))

    expect(
      await screen.findByRole('heading', { name: 'Enter your code' }),
    ).toBeInTheDocument()
    expect(screen.getByText('s***@example.com')).toBeInTheDocument()
    expect(clerkMocks.signIn.mfa.sendEmailCode).toHaveBeenCalledOnce()
  })

  it('closes native Google auth only after Clerk activates a session', async () => {
    const user = userEvent.setup()
    authPlatformMocks.native = true
    clerkMocks.client.signIn.authenticateWithRedirect.mockImplementation(
      async () => {
        clerkMocks.client.lastActiveSessionId = 'sess_google'
        clerkMocks.client.signedInSessions = [
          { id: 'sess_google', status: 'active', user: null },
        ]
      },
    )

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(
      clerkMocks.client.signIn.authenticateWithRedirect,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        strategy: 'oauth_google',
        redirectUrl: 'com.simerfamily.kinsphere://callback',
      }),
    )
  })

  it('keeps native Google auth open when Clerk does not activate a session', async () => {
    const user = userEvent.setup()
    authPlatformMocks.native = true

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))

    expect(
      await screen.findByText(/could not finish signing you in/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Continue with Google' }),
    ).toBeEnabled()
  })

  it('keeps native Google auth open for a pending Clerk session', async () => {
    const user = userEvent.setup()
    authPlatformMocks.native = true
    clerkMocks.client.signIn.authenticateWithRedirect.mockImplementation(
      async () => {
        clerkMocks.client.lastActiveSessionId = 'sess_pending'
        clerkMocks.client.signedInSessions = [
          { id: 'sess_pending', status: 'pending', user: null },
        ]
      },
    )

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))

    expect(
      await screen.findByText(/could not finish signing you in/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('sends an email code and preserves a safe return route', async () => {
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

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.type(screen.getByLabelText('Email address'), ' User@Example.com ')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))

    expect(clerkMocks.signIn.create).toHaveBeenCalledWith({
      identifier: 'user@example.com',
      signUpIfMissing: true,
    })
    expect(clerkMocks.signIn.emailCode.sendCode).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: 'Enter your code' })).toBeInTheDocument()
    expect(window.sessionStorage.getItem('kinsphere.auth.returnTo')).toBe(
      '/journal?view=list',
    )
  })

  it('recovers from rejected resend and change-email resets without trapping the form', async () => {
    const user = userEvent.setup()
    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.type(screen.getByLabelText('Email address'), 'family@example.com')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))

    clerkMocks.signIn.emailCode.sendCode.mockRejectedValueOnce(
      new Error('offline'),
    )
    await user.click(screen.getByRole('button', { name: 'Send a new code' }))
    expect(
      await screen.findByText(/check your connection and try again/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send a new code' })).toBeEnabled()

    clerkMocks.signIn.reset.mockRejectedValueOnce(new Error('offline'))
    await user.click(screen.getByRole('button', { name: 'Change email' }))
    expect(
      await screen.findByText(/check your connection and try again/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Enter your code' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change email' })).toBeEnabled()
  })

  it('verifies an existing user and activates the Clerk session', async () => {
    const user = userEvent.setup()
    clerkMocks.signIn.emailCode.verifyCode.mockImplementation(async () => {
      clerkMocks.signIn.status = 'complete'
      return { error: null }
    })

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.type(screen.getByLabelText('Email address'), 'family@example.com')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))
    await user.type(screen.getByLabelText('Verification code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(clerkMocks.signIn.emailCode.verifyCode).toHaveBeenCalledWith({
      code: '123456',
    })
    expect(clerkMocks.signIn.finalize).toHaveBeenCalledOnce()
  })

  it('reactivates only the exact existing Clerk session', async () => {
    const user = userEvent.setup()
    clerkMocks.signIn.existingSession = { sessionId: 'sess_family' }
    clerkMocks.signIn.create.mockResolvedValue({
      error: { errors: [{ code: 'session_exists' }] },
    })

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.type(screen.getByLabelText('Email address'), 'family@example.com')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))

    expect(clerkMocks.setActive).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'sess_family' }),
    )
    expect(clerkMocks.client.reload).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('matches a refreshed session by email instead of activating the first session', async () => {
    const user = userEvent.setup()
    clerkMocks.signIn.create.mockResolvedValue({
      error: { errors: [{ code: 'session_exists' }] },
    })
    clerkMocks.client.signedInSessions = [
      {
        id: 'sess_someone_else',
        user: { emailAddresses: [{ emailAddress: 'other@example.com' }] },
      },
      {
        id: 'sess_family',
        user: { emailAddresses: [{ emailAddress: 'Family@Example.com' }] },
      },
    ]

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.type(screen.getByLabelText('Email address'), 'family@example.com')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))

    expect(clerkMocks.client.reload).toHaveBeenCalledOnce()
    expect(clerkMocks.setActive).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'sess_family' }),
    )
  })

  it('does not activate another account when the existing session does not match', async () => {
    const user = userEvent.setup()
    clerkMocks.signIn.create.mockResolvedValue({
      error: { errors: [{ code: 'session_exists' }] },
    })
    clerkMocks.client.signedInSessions = [
      {
        id: 'sess_someone_else',
        user: { emailAddresses: [{ emailAddress: 'other@example.com' }] },
      },
    ]

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.type(screen.getByLabelText('Email address'), 'family@example.com')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))

    expect(clerkMocks.setActive).not.toHaveBeenCalled()
    expect(
      screen.getByText(/another account is already open on this device/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send me a code' })).toBeEnabled()
  })

  it('releases the loading state when existing-session activation fails', async () => {
    const user = userEvent.setup()
    clerkMocks.signIn.existingSession = { sessionId: 'sess_family' }
    clerkMocks.signIn.create.mockResolvedValue({
      error: { errors: [{ code: 'session_exists' }] },
    })
    clerkMocks.setActive.mockRejectedValue(new Error('offline'))

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.type(screen.getByLabelText('Email address'), 'family@example.com')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))

    expect(screen.getByText(/check your connection and try again/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send me a code' })).toBeEnabled()
  })

  it('releases the loading state when Clerk session finalization throws', async () => {
    const user = userEvent.setup()
    clerkMocks.signIn.emailCode.verifyCode.mockImplementation(async () => {
      clerkMocks.signIn.status = 'complete'
      return { error: null }
    })
    clerkMocks.signIn.finalize.mockRejectedValue(new Error('offline'))

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.type(screen.getByLabelText('Email address'), 'family@example.com')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))
    await user.type(screen.getByLabelText('Verification code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByText(/check your connection and try again/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  it('creates a new Clerk user only after the email code is verified', async () => {
    const user = userEvent.setup()
    clerkMocks.signIn.emailCode.verifyCode.mockResolvedValue({
      error: {
        errors: [{ code: 'sign_up_if_missing_transfer' }],
      },
    })
    clerkMocks.signUp.create.mockImplementation(async () => {
      clerkMocks.signUp.status = 'complete'
      return { error: null }
    })

    render(
      <AuthProvider value={authValue('signed-out')}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.type(screen.getByLabelText('Email address'), 'new@example.com')
    await user.click(screen.getByRole('button', { name: 'Send me a code' }))
    await user.type(screen.getByLabelText('Verification code'), '424242')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(clerkMocks.signUp.create).toHaveBeenCalledWith({ transfer: true })
    expect(clerkMocks.signUp.finalize).toHaveBeenCalledOnce()
  })

  it('offers explicit demo access while Clerk is signed out', async () => {
    const user = userEvent.setup()
    const startDevelopmentPreview = vi.fn()

    render(
      <AuthProvider
        value={{
          ...authValue('signed-out'),
          startDevelopmentPreview,
        }}
      >
        <MemoryRouter
          initialEntries={[
            { pathname: '/login', state: { returnTo: '/capsule' } },
          ]}
        >
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(
      screen.getByRole('button', { name: 'Explore the demo' }),
    )

    expect(startDevelopmentPreview).toHaveBeenCalledOnce()
    expect(window.sessionStorage.getItem('kinsphere.auth.returnTo')).toBe(
      '/capsule',
    )
  })

  it('sends demo access to home instead of a stale onboarding route', async () => {
    const user = userEvent.setup()
    const startDevelopmentPreview = vi.fn()

    render(
      <AuthProvider
        value={{
          ...authValue('signed-out'),
          startDevelopmentPreview,
        }}
      >
        <MemoryRouter
          initialEntries={[
            { pathname: '/login', state: { returnTo: '/onboarding' } },
          ]}
        >
          <AuthPage />
        </MemoryRouter>
      </AuthProvider>,
    )

    await user.click(
      screen.getByRole('button', { name: 'Explore the demo' }),
    )

    expect(window.sessionStorage.getItem('kinsphere.auth.returnTo')).toBe('/')
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

  it('redirects an active demo session away from onboarding', async () => {
    window.sessionStorage.setItem('kinsphere.auth.returnTo', '/onboarding')
    render(
      <AuthProvider
        value={{
          ...authValue('signed-in', signedInUser),
          isDevelopmentPreview: true,
        }}
      >
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<AuthPage />} />
            <Route path="/" element={<p>Demo home</p>} />
            <Route path="/onboarding" element={<p>Onboarding trap</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    )

    expect(await screen.findByText('Demo home')).toBeInTheDocument()
    expect(screen.queryByText('Onboarding trap')).not.toBeInTheDocument()
  })

  it.each(['signed-out', 'unconfigured'] as const)(
    'redirects %s users to login and preserves the private route',
    async (status) => {
      render(
        <AuthProvider value={authValue(status)}>
          <MemoryRouter initialEntries={['/events?view=week#task-42']}>
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
      ).toHaveTextContent('/events?view=week#task-42')
      expect(screen.queryByText('Private events')).not.toBeInTheDocument()
    },
  )
})
