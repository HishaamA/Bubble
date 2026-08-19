import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const persistence = vi.hoisted(() => ({
  readProfilePreferences: vi.fn(),
  updateProfilePreferences: vi.fn(),
}))

const auth = vi.hoisted(() => ({
  signOut: vi.fn(async () => undefined),
}))

vi.mock('../auth', () => ({
  useAuth: () => ({
    signOut: auth.signOut,
    user: {
      id: 'user_clerk_alice',
      displayName: 'Alice Ahmed',
      email: 'alice@example.test',
      phone: null,
      imageUrl: 'https://images.example/alice.jpg',
    },
  }),
}))

vi.mock('../../services/persistence', () => persistence)

// ProfilePage owns the disclosure and summary; FamilySyncPanel's backend states
// have their own focused suite. Keep this test deterministic even when a local
// developer has valid Supabase credentials in .env.local.
vi.mock('./family-sync', () => ({
  FamilySyncPanel: () => (
    <section aria-label="Family Sync">
      <h2>Family Sync</h2>
      <h3>Family groups need a connection</h3>
      <p>Connect Supabase to securely create a group and share invite codes.</p>
      <a href="/login">Open secure sign-in</a>
    </section>
  ),
}))

import { ProfilePage } from './ProfilePage'

beforeEach(() => {
  vi.clearAllMocks()
  persistence.readProfilePreferences.mockResolvedValue({
    notificationsEnabled: true,
    quietHoursEnabled: true,
    quietHoursStart: '22:00:00',
    quietHoursEnd: '08:00:00',
  })
  persistence.updateProfilePreferences.mockImplementation(
    async (patch: {
      notificationsEnabled?: boolean
      quietHoursEnabled?: boolean
    }) => ({
      notificationsEnabled: patch.notificationsEnabled ?? true,
      quietHoursEnabled: patch.quietHoursEnabled ?? true,
      quietHoursStart:
        patch.quietHoursEnabled === false ? null : '22:00:00',
      quietHoursEnd:
        patch.quietHoursEnabled === false ? null : '08:00:00',
    }),
  )
})

describe('ProfilePage', () => {
  it('keeps family sharing accessible and updates preference state', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/profile']}>
        <Routes>
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/login" element={<p>Signed-out destination</p>} />
        </Routes>
      </MemoryRouter>,
    )

    expect(
      screen.getByRole('heading', { name: 'Alice Ahmed' }),
    ).toBeInTheDocument()
    expect(screen.getByText('alice@example.test')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Alice Ahmed profile' })).toHaveAttribute(
      'src',
      'https://images.example/alice.jpg',
    )

    const updates = screen.getByRole('switch', { name: 'Family updates' })
    expect(updates).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => {
      expect(persistence.readProfilePreferences).toHaveBeenCalledTimes(1)
    })
    await user.click(updates)
    await waitFor(() => {
      expect(updates).toHaveAttribute('aria-checked', 'false')
    })
    expect(persistence.updateProfilePreferences).toHaveBeenCalledWith({
      notificationsEnabled: false,
    })

    const quietHours = screen.getByRole('switch', {
      name: 'Quiet evenings',
    })
    await user.click(quietHours)
    await waitFor(() => {
      expect(quietHours).toHaveAttribute('aria-checked', 'false')
    })
    expect(persistence.updateProfilePreferences).toHaveBeenCalledWith({
      quietHoursEnabled: false,
    })

    await user.click(screen.getByRole('button', { name: 'Manage family sharing' }))
    expect(screen.getByRole('heading', { name: 'Family Sync' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close family sharing' })).toHaveAttribute('aria-expanded', 'true')
    expect(
      await screen.findByRole('heading', { name: 'Family groups need a connection' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/securely create a group and share invite codes/i)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Open secure sign-in' }),
    ).toHaveAttribute('href', '/login')

    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(auth.signOut).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Signed-out destination')).toBeInTheDocument()
  })
})
