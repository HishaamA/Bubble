import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AuthProvider, type AuthContextValue } from '../auth'
import { FamilyOnboardingProvider } from './FamilyOnboardingProvider'
import { OnboardingPage } from './OnboardingPage'
import type { FamilyOnboardingAdapter } from './types'

const shareCode = 'BUB-1234-5678-90AB-CDEF-1234-5678'

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
    loadAccess: vi.fn(async () => ({ kind: 'needs-family' as const })),
    createFamily: vi.fn(async () => ({
      kind: 'member' as const,
      membership: {
        familyId: 'family-1',
        familyName: 'The Ahmed family',
        role: 'owner' as const,
        ownerId: 'user_A',
        memberCount: 1,
        shareCode,
      },
    })),
    joinFamily: vi.fn(async () => ({
      kind: 'member' as const,
      membership: {
        familyId: 'family-1',
        familyName: 'The Ahmed family',
        role: 'member' as const,
        ownerId: 'user_A',
        memberCount: 2,
        shareCode,
      },
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
          initialEntries={[{ pathname: '/onboarding', state: { returnTo } }]}
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
  it('opens directly on family setup and shows the persistent code after creation', async () => {
    const user = userEvent.setup()
    const adapter = adapterWith()
    renderOnboarding(adapter)

    expect(
      await screen.findByRole('heading', { name: 'Find your family.' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Step \d of/i)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Create a family/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Join with a code/ }),
    ).toBeInTheDocument()

    await user.type(screen.getByLabelText('Family name'), 'The Ahmed family')
    await user.click(screen.getByRole('button', { name: 'Create family' }))

    expect(
      await screen.findByRole('heading', {
        name: 'The Ahmed family is on Bubble.',
      }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Family share code')).toHaveTextContent(shareCode)
    expect(adapter.createFamily).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_A' }),
      'The Ahmed family',
    )

    await user.click(screen.getByRole('button', { name: 'Enter Bubble' }))
    expect(await screen.findByText('Private journal')).toBeInTheDocument()
  })

  it('joins a family with its code and enters the requested route immediately', async () => {
    const user = userEvent.setup()
    const adapter = adapterWith()
    renderOnboarding(adapter, '/')

    await screen.findByRole('heading', { name: 'Find your family.' })
    await user.click(screen.getByRole('button', { name: /Join with a code/ }))
    await user.type(screen.getByLabelText('Private family code'), shareCode)
    await user.click(screen.getByRole('button', { name: 'Join family' }))

    expect(await screen.findByText('Private home')).toBeInTheDocument()
    expect(adapter.joinFamily).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_A' }),
      shareCode,
    )
  })

  it('keeps legacy one-use invites in their approval state', async () => {
    const adapter = adapterWith({
      loadAccess: vi.fn(async () => ({
        kind: 'pending' as const,
        familyName: 'Ahmed family',
      })),
    })
    renderOnboarding(adapter, '/')

    expect(
      await screen.findByText(/Ahmed family still needs to approve it/i),
    ).toBeInTheDocument()
  })
})
