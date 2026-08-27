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
    rotateFamilyCode: vi.fn(async () =>
      'BUB-FFFF-EEEE-DDDD-CCCC-BBBB-AAAA'),
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
    expect(screen.getByText(/share its family code/i)).toBeInTheDocument()
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
          shareCode: 'BUB-1111-2222-3333-4444-5555-6666',
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

  it('joins a family immediately with its persistent code', async () => {
    const user = userEvent.setup()
    const setup = createAdapter({
      kind: 'unjoined',
      person,
      pendingRequest: null,
    })
    const code = 'BUB-ABCD-1234-EF56-7890-ABCD-1234'
    setup.adapter.requestCircleJoin = vi.fn(async () => {
      setup.setSnapshot({
        kind: 'connected',
        person,
        circle: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          name: 'Ahmed family',
          role: 'member',
          memberCount: 4,
          shareCode: code,
        },
        pendingRequests: [],
      })
    })

    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    await user.type(await screen.findByLabelText('Family code'), code)
    await user.click(screen.getByRole('button', { name: 'Join family' }))

    expect(setup.adapter.requestCircleJoin).toHaveBeenCalledWith(code)
    expect(
      await screen.findByRole('heading', { name: 'Ahmed family' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/4 members · member/i)).toBeInTheDocument()
  })

  it('keeps legacy invite codes working as approval requests', async () => {
    const user = userEvent.setup()
    const setup = createAdapter({
      kind: 'unjoined',
      person,
      pendingRequest: null,
    })
    const enteredCode = `KS1_${'A'.repeat(64)}`
    const normalizedCode = enteredCode.toLowerCase()
    setup.adapter.requestCircleJoin = vi.fn(async () => {
      setup.setSnapshot({
        kind: 'unjoined',
        person,
        pendingRequest: {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          createdAt: '2026-08-26T12:00:00.000Z',
        },
      })
    })

    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    await user.type(await screen.findByLabelText('Family code'), enteredCode)
    await user.click(screen.getByRole('button', { name: 'Join family' }))

    expect(setup.adapter.requestCircleJoin).toHaveBeenCalledWith(normalizedCode)
    expect(
      await screen.findByText(/request was sent/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Waiting for your family' }),
    ).toBeInTheDocument()
  })

  it('keeps the persistent code visible, copies and shares it, and handles legacy requests', async () => {
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
        shareCode: 'BUB-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
      },
      pendingRequests: [pendingRequest],
    }
    const setup = createAdapter(connected)
    const shareCode = vi.fn(async () => 'shared' as const)
    const copyCode = vi.fn(async () => undefined)
    setup.adapter.decideJoinRequest = vi.fn(async () => {
      setup.setSnapshot({ ...connected, pendingRequests: [] })
    })

    renderPanel(
      <FamilySyncPanel
        adapter={setup.adapter}
        shareCode={shareCode}
        copyCode={copyCode}
      />,
    )

    const familyCode = 'BUB-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF'
    expect(await screen.findByText(familyCode)).toBeInTheDocument()
    expect(screen.getByText(/code stays in settings/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(copyCode).toHaveBeenCalledWith(familyCode)
    expect(await screen.findByText(/family code was copied/i)).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', {
        name: 'Share family code for Ahmed family',
      }),
    )
    expect(shareCode).toHaveBeenCalledWith(
      familyCode,
      'Ahmed family',
    )
    expect(
      await screen.findByText(/ready in the share sheet/i),
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

  it('lets every connected family member retrieve the saved code', async () => {
    const familyCode = 'BUB-9999-8888-7777-6666-5555-4444'
    const setup = createAdapter({
      kind: 'connected',
      person,
      circle: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Ahmed family',
        role: 'member',
        memberCount: 5,
        shareCode: familyCode,
      },
      pendingRequests: [],
    })

    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)

    expect(await screen.findByText(familyCode)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Share family code for Ahmed family' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Join requests' })).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Replace family code' }),
    ).toBeNull()
  })

  it('lets the owner confirm and rotate the saved family code', async () => {
    const user = userEvent.setup()
    const currentCode = 'BUB-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF'
    const nextCode = 'BUB-FFFF-EEEE-DDDD-CCCC-BBBB-AAAA'
    const connected: FamilySyncSnapshot = {
      kind: 'connected',
      person,
      circle: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Ahmed family',
        role: 'owner',
        memberCount: 3,
        shareCode: currentCode,
      },
      pendingRequests: [],
    }
    const setup = createAdapter(connected)
    setup.adapter.rotateFamilyCode = vi.fn(async () => {
      setup.setSnapshot({
        ...connected,
        circle: { ...connected.circle, shareCode: nextCode },
      })
      return nextCode
    })

    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)

    await user.click(
      await screen.findByRole('button', { name: 'Replace family code' }),
    )
    expect(
      screen.getByRole('group', { name: 'Confirm family code rotation' }),
    ).toBeInTheDocument()
    expect(setup.adapter.rotateFamilyCode).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Create new code' }))

    expect(setup.adapter.rotateFamilyCode).toHaveBeenCalledWith(
      connected.circle.id,
    )
    expect(await screen.findByText(nextCode)).toBeInTheDocument()
    expect(
      screen.getByText(/previous code no longer works/i),
    ).toBeInTheDocument()
  })
})
