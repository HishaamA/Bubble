import { useEffect, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, type AuthContextValue } from '../auth'
import {
  FamilyOnboardingProvider,
  toFamilyOnboardingMessage,
  useFamilyOnboarding,
} from './FamilyOnboardingProvider'
import { RequireFamilyMembership } from './RequireFamilyMembership'
import type { FamilyOnboardingAdapter } from './types'

function signedInValue(userId: string): AuthContextValue {
  return {
    status: 'signed-in',
    user: {
      id: userId,
      displayName: userId === 'user_A' ? 'Amina' : 'Bilal',
      email: `${userId}@example.com`,
      phone: null,
      imageUrl: null,
    },
    getToken: vi.fn(async () => `${userId}-token`),
    signOut: vi.fn(async () => undefined),
  }
}

function createAdapter(): FamilyOnboardingAdapter {
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
  }
}

function StateProbe() {
  const { completeTutorial, refresh, status } = useFamilyOnboarding()
  const [completion, setCompletion] = useState('idle')
  return (
    <div>
      <output aria-label="Family gate status">{status}</output>
      <output aria-label="Tutorial completion result">{completion}</output>
      <button
        type="button"
        onClick={() => {
          void completeTutorial().then((completed) =>
            setCompletion(completed ? 'advanced' : 'cancelled'),
          )
        }}
      >
        Complete tutorial
      </button>
      <button type="button" onClick={() => void refresh()}>
        Check membership
      </button>
    </div>
  )
}

function TestTree({
  adapter,
  auth,
}: {
  adapter: FamilyOnboardingAdapter
  auth: AuthContextValue
}) {
  return (
    <AuthProvider value={auth}>
      <FamilyOnboardingProvider adapter={adapter}>
        <StateProbe />
      </FamilyOnboardingProvider>
    </AuthProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('FamilyOnboardingProvider', () => {
  it('persists the tutorial before opening family setup', async () => {
    const user = userEvent.setup()
    const adapter = createAdapter()
    render(<TestTree adapter={adapter} auth={signedInValue('user_A')} />)

    expect(
      await screen.findByText('tutorial', { selector: 'output' }),
    ).toBeInTheDocument()
    expect(adapter.loadAccess).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Complete tutorial' }))
    expect(
      await screen.findByText('needs-family', { selector: 'output' }),
    ).toBeInTheDocument()
    expect(adapter.completeTutorial).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_A' }),
    )
    expect(screen.getByLabelText('Tutorial completion result')).toHaveTextContent(
      'advanced',
    )
  })

  it('revalidates a pending request into membership on demand and on focus', async () => {
    const user = userEvent.setup()
    const adapter = createAdapter()
    vi.mocked(adapter.readTutorial).mockResolvedValue(true)
    vi.mocked(adapter.loadAccess)
      .mockResolvedValueOnce({ kind: 'pending', familyName: 'Ahmed family' })
      .mockResolvedValue({
        kind: 'member',
        membership: {
          familyId: 'family-1',
          familyName: 'Ahmed family',
          role: 'member',
        },
      })
    render(<TestTree adapter={adapter} auth={signedInValue('user_A')} />)

    expect(
      await screen.findByText('pending', { selector: 'output' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Check membership' }))
    expect(
      await screen.findByText('member', { selector: 'output' }),
    ).toBeInTheDocument()

    fireEvent.focus(window)
    await waitFor(() => expect(adapter.loadAccess).toHaveBeenCalledTimes(3))
  })

  it('keeps a resolved member subtree mounted during a deferred focus refresh', async () => {
    const adapter = createAdapter()
    const approved = {
      kind: 'member' as const,
      membership: {
        familyId: 'family-1',
        familyName: 'Ahmed family',
        role: 'member' as const,
      },
    }
    let resolveRefresh: ((value: typeof approved) => void) | undefined
    vi.mocked(adapter.readTutorial).mockResolvedValue(true)
    vi.mocked(adapter.loadAccess)
      .mockResolvedValueOnce(approved)
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve
          }),
      )
    const onUnmount = vi.fn()

    function MemberView() {
      useEffect(() => () => onUnmount(), [])
      return <p>Mounted capture draft</p>
    }

    render(
      <AuthProvider value={signedInValue('user_A')}>
        <FamilyOnboardingProvider adapter={adapter}>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/onboarding" element={<p>Family setup</p>} />
              <Route element={<RequireFamilyMembership />}>
                <Route path="/" element={<MemberView />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </FamilyOnboardingProvider>
      </AuthProvider>,
    )

    expect(await screen.findByText('Mounted capture draft')).toBeInTheDocument()
    fireEvent.focus(window)
    await waitFor(() => expect(adapter.loadAccess).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Mounted capture draft')).toBeInTheDocument()
    expect(onUnmount).not.toHaveBeenCalled()

    await act(async () => resolveRefresh?.(approved))
    expect(screen.getByText('Mounted capture draft')).toBeInTheDocument()
    expect(onUnmount).not.toHaveBeenCalled()
  })

  it('does not advance account B when account A tutorial completion resolves late', async () => {
    const user = userEvent.setup()
    const adapter = createAdapter()
    let resolveAccountA: (() => void) | undefined
    vi.mocked(adapter.completeTutorial).mockImplementation(
      ({ userId }) =>
        userId === 'user_A'
          ? new Promise<void>((resolve) => {
              resolveAccountA = resolve
            })
          : Promise.resolve(),
    )
    const view = render(
      <TestTree adapter={adapter} auth={signedInValue('user_A')} />,
    )
    await screen.findByText('tutorial', { selector: 'output' })
    await user.click(screen.getByRole('button', { name: 'Complete tutorial' }))

    view.rerender(
      <TestTree adapter={adapter} auth={signedInValue('user_B')} />,
    )
    expect(
      await screen.findByText('tutorial', { selector: 'output' }),
    ).toBeInTheDocument()
    await act(async () => resolveAccountA?.())

    await waitFor(() =>
      expect(screen.getByLabelText('Tutorial completion result')).toHaveTextContent(
        'cancelled',
      ),
    )
    expect(screen.getByLabelText('Family gate status')).toHaveTextContent(
      'tutorial',
    )
  })

  it('maps service failures without exposing raw database messages', () => {
    expect(toFamilyOnboardingMessage(new Error('invalid_invite_code'))).toBe(
      'That family code is not valid.',
    )
    expect(
      toFamilyOnboardingMessage(
        new Error('duplicate key violates secret_internal_constraint'),
      ),
    ).toBe('Family setup could not be completed. Please try again.')
    expect(
      toFamilyOnboardingMessage(new Error('Failed to fetch')),
    ).toMatch(/check your connection/i)
  })
})
