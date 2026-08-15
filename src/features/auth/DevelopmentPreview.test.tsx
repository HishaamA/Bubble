import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  MemoryRouter,
  Outlet,
  Route,
  Routes,
} from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FamilyOnboardingProvider,
  RequireFamilyMembership,
  unavailableFamilyOnboardingAdapter,
} from '../onboarding'
import { AuthPage } from './AuthPage'
import { AuthProvider, RequireAuthentication } from './AuthProvider'
import { useAuth } from './authContext'
import {
  canUseDevelopmentPreview,
  developmentPreviewAvailable,
} from './developmentPreview'

vi.mock('./config', () => ({ clerkConfigured: false }))

function PreviewDestination() {
  const { signOut, user } = useAuth()
  return (
    <section>
      <h1>Development main app</h1>
      <p>{user?.displayName}</p>
      <button type="button" onClick={() => void signOut()}>
        Sign out of preview
      </button>
    </section>
  )
}

function PreviewRoutes() {
  return (
    <AuthProvider>
      <FamilyOnboardingProvider adapter={unavailableFamilyOnboardingAdapter}>
        <MemoryRouter initialEntries={['/journal']}>
          <Routes>
            <Route path="/login" element={<AuthPage />} />
            <Route element={<RequireAuthentication />}>
              <Route element={<RequireFamilyMembership />}>
                <Route path="/journal" element={<PreviewDestination />} />
                <Route path="/" element={<Outlet />} />
              </Route>
            </Route>
          </Routes>
        </MemoryRouter>
      </FamilyOnboardingProvider>
    </AuthProvider>
  )
}

afterEach(() => {
  window.sessionStorage.clear()
})

describe('development preview authentication', () => {
  it('is compile-time disabled outside development and whenever Clerk exists', () => {
    expect(canUseDevelopmentPreview(false, false)).toBe(false)
    expect(canUseDevelopmentPreview(false, true)).toBe(false)
    expect(canUseDevelopmentPreview(true, true)).toBe(false)
    expect(canUseDevelopmentPreview(true, false)).toBe(true)
    expect(canUseDevelopmentPreview(false, false, true)).toBe(false)
    expect(canUseDevelopmentPreview(false, true, true)).toBe(false)
  })

  it('lets a developer opt in, bypasses family setup, and restores after reload', async () => {
    expect(developmentPreviewAvailable).toBe(true)
    const user = userEvent.setup()
    const firstRender = render(<PreviewRoutes />)

    const continueButton = await screen.findByRole('button', {
      name: 'Continue to main app',
    })
    await user.click(continueButton)
    expect(
      await screen.findByRole('heading', { name: 'Development main app' }),
    ).toBeInTheDocument()
    expect(screen.getByText('KinSphere Preview')).toBeInTheDocument()
    firstRender.unmount()

    render(<PreviewRoutes />)
    expect(
      await screen.findByRole('heading', { name: 'Development main app' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: /Who are you coming home to/i }),
    ).not.toBeInTheDocument()
  })

  it('clears the persisted preview session on sign-out', async () => {
    const user = userEvent.setup()
    render(<PreviewRoutes />)
    await user.click(
      await screen.findByRole('button', { name: 'Continue to main app' }),
    )
    await user.click(
      await screen.findByRole('button', { name: 'Sign out of preview' }),
    )

    expect(
      await screen.findByRole('button', { name: 'Continue to main app' }),
    ).toBeInTheDocument()
  })
})
