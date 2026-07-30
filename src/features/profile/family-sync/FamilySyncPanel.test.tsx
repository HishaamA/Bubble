import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FamilySyncPanel } from './FamilySyncPanel'
import { FAMILY_SYNC_REFRESH_EVENT } from './familySyncAdapter'
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

const person = {
  id: '10000000-0000-4000-8000-000000000001',
  displayName: 'Simreen',
  email: 'simreen@example.com',
}

describe('FamilySyncPanel', () => {
  it('honestly identifies an unconfigured backend as local-only', async () => {
    const { adapter } = createAdapter({ kind: 'local-only' })
    render(<FamilySyncPanel adapter={adapter} />)

    expect(
      await screen.findByRole('heading', {
        name: 'Your moments stay on this device',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText(/not connected to a backend/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument()
  })

  it('signs in and announces that root sync should reconnect', async () => {
    const user = userEvent.setup()
    const setup = createAdapter({ kind: 'signed-out' })
    const refreshListener = vi.fn()
    window.addEventListener(FAMILY_SYNC_REFRESH_EVENT, refreshListener)
    setup.adapter.signIn = vi.fn(async () => {
      setup.setSnapshot({ kind: 'unjoined', person, pendingRequest: null })
    })

    render(<FamilySyncPanel adapter={setup.adapter} />)
    await screen.findByRole('heading', { name: 'Connect your family' })
    await user.type(screen.getByLabelText('Email'), person.email)
    await user.type(screen.getByLabelText('Password'), 'safe-password')
    await user.click(screen.getByRole('button', { name: 'Sign in securely' }))

    expect(setup.adapter.signIn).toHaveBeenCalledWith(
      person.email,
      'safe-password',
    )
    expect(await screen.findByText(person.displayName)).toBeInTheDocument()
    expect(refreshListener).toHaveBeenCalledTimes(1)
    window.removeEventListener(FAMILY_SYNC_REFRESH_EVENT, refreshListener)
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

    render(<FamilySyncPanel adapter={setup.adapter} />)
    await user.type(await screen.findByLabelText('Circle name'), 'Ahmed family')
    await user.click(screen.getByRole('button', { name: 'Create circle' }))

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

    render(<FamilySyncPanel adapter={setup.adapter} />)
    await user.type(await screen.findByLabelText('Invite code'), code)
    await user.click(screen.getByRole('button', { name: 'Request to join' }))

    expect(setup.adapter.requestCircleJoin).toHaveBeenCalledWith(code)
    expect(
      await screen.findByRole('heading', { name: 'Waiting for family approval' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/moments will sync after/i)).toBeInTheDocument()
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
    setup.adapter.decideJoinRequest = vi.fn(async () => {
      setup.setSnapshot({ ...connected, pendingRequests: [] })
    })

    render(<FamilySyncPanel adapter={setup.adapter} />)
    await user.click(
      await screen.findByRole('button', { name: 'Create invite' }),
    )

    const generatedCode = `ks1_${'a'.repeat(64)}`
    expect(screen.getByText(generatedCode)).toBeInTheDocument()
    expect(screen.getByText(/share it only with the person/i)).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: /approve request from member 20000000/i }),
    )
    expect(setup.adapter.decideJoinRequest).toHaveBeenCalledWith(
      pendingRequest.id,
      'approved',
    )
    await waitFor(() => {
      expect(screen.getByText('No one is waiting for approval.')).toBeInTheDocument()
    })
  })
})
