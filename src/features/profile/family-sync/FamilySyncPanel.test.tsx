import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { FamilySyncPanel } from './FamilySyncPanel'
import type { FamilySyncAdapter, FamilySyncSnapshot } from './types'

function createAdapter(initialSnapshot: FamilySyncSnapshot) {
  let snapshot = initialSnapshot
  const adapter: FamilySyncAdapter = {
    loadSnapshot: vi.fn(async () => snapshot),
    signIn: vi.fn(async () => undefined),
    signUp: vi.fn(async () => ({ requiresEmailConfirmation: false })),
    signOut: vi.fn(async () => undefined),
    createCircle: vi.fn(async () => undefined),
    requestCircleJoin: vi.fn(async () => undefined),
    createCircleInvite: vi.fn(async (circleId) => ({
      circleId,
      code: `ks1_${'a'.repeat(64)}`,
      expiresAt: '2026-09-02T12:00:00.000Z',
      maxUses: 1,
    })),
    decideJoinRequest: vi.fn(async () => undefined),
  }
  return {
    adapter,
    setSnapshot(nextSnapshot: FamilySyncSnapshot) {
      snapshot = nextSnapshot
    },
  }
}

function renderPanel(panel: React.ReactNode) {
  return render(<MemoryRouter>{panel}</MemoryRouter>)
}

const person = {
  id: '10000000-0000-4000-8000-000000000001',
  displayName: 'Simreen',
  email: 'simreen@example.com',
}

describe('FamilySyncPanel', () => {
  it('honestly identifies an unconfigured backend as local-only', async () => {
    const { adapter } = createAdapter({ kind: 'local-only' })
    renderPanel(<FamilySyncPanel adapter={adapter} />)

    expect(
      await screen.findByRole('heading', {
        name: 'Family groups need a connection',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText(/share invite codes/i)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Open secure sign-in' }),
    ).toHaveAttribute('href', '/login')
  })

  it('sends signed-out people to the dedicated secure login page', async () => {
    const setup = createAdapter({ kind: 'signed-out' })

    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    await screen.findByRole('heading', { name: 'Keep your family close' })
    expect(
      screen.getByRole('link', { name: 'Sign in or create an account' }),
    ).toHaveAttribute('href', '/login')
    expect(setup.adapter.signIn).not.toHaveBeenCalled()
  })

  it('creates a circle for an authenticated person', async () => {
    const user = userEvent.setup()
    const setup = createAdapter({
      kind: 'unjoined',
      person,
      pendingRequest: null,
    })
    setup.adapter.createCircle = vi.fn(async () => {
      setup.setSnapshot({
        kind: 'connected',
        person,
        circle: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          name: 'Ahmed family',
          role: 'owner',
          memberCount: 1,
        },
        pendingRequests: [],
      })
    })

    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    await user.type(await screen.findByLabelText('Family group name'), 'Ahmed family')
    await user.click(screen.getByRole('button', { name: 'Create family group' }))

    expect(setup.adapter.createCircle).toHaveBeenCalledWith('Ahmed family')
    expect(
      await screen.findByRole('heading', { name: 'Ahmed family' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/1 member · owner/i)).toBeInTheDocument()
  })

  it('submits a private invite code and shows the pending state', async () => {
    const user = userEvent.setup()
    const setup = createAdapter({
      kind: 'unjoined',
      person,
      pendingRequest: null,
    })
    const code = `ks1_${'b'.repeat(64)}`
    setup.adapter.requestCircleJoin = vi.fn(async () => {
      setup.setSnapshot({
        kind: 'unjoined',
        person,
        pendingRequest: {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          createdAt: '2026-08-26T12:00:00.000Z',
        },
      })
    })

    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    await user.type(await screen.findByLabelText('Family code'), code)
    await user.click(screen.getByRole('button', { name: 'Ask to join' }))

    expect(setup.adapter.requestCircleJoin).toHaveBeenCalledWith(code)
    expect(
      await screen.findByRole('heading', { name: 'Waiting for your family' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/moments will appear once/i)).toBeInTheDocument()
  })

  it('keeps a generated invite visible and lets an owner approve a request', async () => {
    const user = userEvent.setup()
    const pendingRequest = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      requesterId: '20000000-0000-4000-8000-000000000002',
      createdAt: '2026-08-26T12:00:00.000Z',
    }
    const connected: FamilySyncSnapshot = {
      kind: 'connected',
      person,
      circle: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Ahmed family',
        role: 'owner',
        memberCount: 1,
      },
      pendingRequests: [pendingRequest],
    }
    const setup = createAdapter(connected)
    const shareInvite = vi.fn(async () => 'shared' as const)
    setup.adapter.decideJoinRequest = vi.fn(async () => {
      setup.setSnapshot({ ...connected, pendingRequests: [] })
    })

    renderPanel(
      <FamilySyncPanel
        adapter={setup.adapter}
        shareInvite={shareInvite}
      />,
    )
    await user.click(
      await screen.findByRole('button', { name: 'Create code' }),
    )

    const generatedCode = `ks1_${'a'.repeat(64)}`
    expect(screen.getByText(generatedCode)).toBeInTheDocument()
    expect(screen.getByText(/one person can use it/i)).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', {
        name: 'Share invite code for Ahmed family',
      }),
    )
    expect(shareInvite).toHaveBeenCalledWith(
      expect.objectContaining({ code: generatedCode }),
      'Ahmed family',
    )
    expect(
      await screen.findByText(/ready in your share sheet/i),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: /approve request from member 20000000/i }),
    )
    expect(setup.adapter.decideJoinRequest).toHaveBeenCalledWith(
      pendingRequest.id,
      'approved',
    )
    await waitFor(() => {
      expect(screen.getByText('No one is waiting to join.')).toBeInTheDocument()
    })
  })
})
