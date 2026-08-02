import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./features/memories/shared', () => ({
  SharedMomentsProvider: ({
    cacheNamespace,
    children,
  }: {
    cacheNamespace: string
    children: ReactNode
  }) => (
    <section data-testid="shared-moments" data-cache-namespace={cacheNamespace}>
      {children}
    </section>
  ),
  FamilyMomentSyncProvider: ({ children }: { children: ReactNode }) => children,
}))

import { AccountScopedData } from './App'
import { AuthProvider, type AuthContextValue } from './features/auth'
import { FamilyOnboardingProvider } from './features/onboarding'
import type {
  FamilyAccessSnapshot,
  FamilyOnboardingAdapter,
} from './features/onboarding'

const auth: AuthContextValue = {
  status: 'signed-in',
  user: {
    id: 'user_A',
    displayName: 'Amina',
    email: 'amina@example.com',
    phone: null,
    imageUrl: null,
  },
  getToken: vi.fn(async () => 'clerk-token'),
  signOut: vi.fn(async () => undefined),
}

function member(familyId: string): FamilyAccessSnapshot {
  return {
    kind: 'member',
    membership: {
      familyId,
      familyName: familyId,
      role: 'member',
    },
  }
}

describe('member-scoped data cache', () => {
  it('changes namespace when the same Clerk user moves to another family', async () => {
    let current = member('family_A')
    const adapter: FamilyOnboardingAdapter = {
      configured: true,
      readTutorial: vi.fn(async () => true),
      completeTutorial: vi.fn(async () => undefined),
      loadAccess: vi.fn(async () => current),
      createFamily: vi.fn(async () => current),
      joinFamily: vi.fn(async () => current),
    }
    render(
      <AuthProvider value={auth}>
        <FamilyOnboardingProvider adapter={adapter}>
          <AccountScopedData>
            <p>Private family data</p>
          </AccountScopedData>
        </FamilyOnboardingProvider>
      </AuthProvider>,
    )

    await waitFor(() =>
      expect(screen.getByTestId('shared-moments')).toHaveAttribute(
        'data-cache-namespace',
        'user_A:family_A',
      ),
    )

    current = member('family_B')
    window.dispatchEvent(new CustomEvent('kinsphere:family-sync-refresh'))
    await waitFor(() =>
      expect(screen.getByTestId('shared-moments')).toHaveAttribute(
        'data-cache-namespace',
        'user_A:family_B',
      ),
    )
  })
})
