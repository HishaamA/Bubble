import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AuthProvider, type AuthContextValue } from '../auth'
import { FamilyOnboardingProvider } from './FamilyOnboardingProvider'
import { OnboardingPage } from './OnboardingPage'
import type { FamilyOnboardingAdapter } from './types'

const auth: AuthContextValue = {
  status: 'signed-in',
  user: {
    id: 'user_A',
    displayName: 'Amina Ahmed',
    email: 'amina@example.com',
    phone: null,
    imageUrl: null,
  },
  getToken: vi.fn(async () => 'clerk-token'),
  signOut: vi.fn(async () => undefined),
}

function adapterWith(
  values: Partial<FamilyOnboardingAdapter> = {},
): FamilyOnboardingAdapter {
  return {
    configured: true,
    readTutorial: vi.fn(async () => false),
    completeTutorial: vi.fn(async () => undefined),
    loadAccess: vi.fn(async () => ({ kind: 'needs-family' as const })),
    createFamily: vi.fn(async () => ({
      kind: 'member' as const,
      membership: {
        familyId: 'family-1',
        familyName: 'The Ahmed family',
        role: 'owner' as const,
      },
    })),
    joinFamily: vi.fn(async () => ({
      kind: 'pending' as const,
      familyName: null,
    })),
    ...values,
  }
}

function renderOnboarding(
  adapter: FamilyOnboardingAdapter,
  returnTo = '/journal',
) {
  return render(
    <AuthProvider value={auth}>
      <FamilyOnboardingProvider adapter={adapter}>
        <MemoryRouter
          initialEntries={[
            { pathname: '/onboarding', state: { returnTo } },
          ]}
        >
          <Routes>
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/journal" element={<p>Private journal</p>} />
            <Route path="/" element={<p>Private home</p>} />
          </Routes>
        </MemoryRouter>
      </FamilyOnboardingProvider>
    </AuthProvider>,
  )
}

describe('OnboardingPage', () => {
  it('persists the tutorial, offers create/join, and enters the requested route as a member', async () => {
    const user = userEvent.setup()
    const adapter = adapterWith()
    renderOnboarding(adapter)

    expect(
      await screen.findByRole('heading', {
        name: 'Feel close to the moments that matter.',
      }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Continue/ }))
    await user.click(screen.getByRole('button', { name: /Continue/ }))
    await user.click(screen.getByRole('button', { name: /Continue/ }))

    expect(
      await screen.findByRole('heading', {
        name: 'Who are you coming home to?',
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Create family/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Join with code/ })).toBeInTheDocument()
    expect(adapter.completeTutorial).toHaveBeenCalledTimes(1)

    await user.type(screen.getByLabelText('Family name'), 'The Ahmed family')
    await user.click(
      screen.getByRole('button', { name: 'Create our family space' }),
    )
    expect(await screen.findByText('Private journal')).toBeInTheDocument()
    expect(adapter.createFamily).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_A' }),
      'The Ahmed family',
    )
  })

  it('lets a pending joiner check again and enters after approval', async () => {
    const user = userEvent.setup()
    const adapter = adapterWith({
      readTutorial: vi.fn(async () => true),
      loadAccess: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'pending', familyName: 'Ahmed family' })
        .mockResolvedValue({
          kind: 'member',
          membership: {
            familyId: 'family-1',
            familyName: 'Ahmed family',
            role: 'member',
          },
        }),
    })
    renderOnboarding(adapter, '/')

    expect(
      await screen.findByText(/needs to approve your request/i),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('Private home')).toBeInTheDocument()
  })
})
