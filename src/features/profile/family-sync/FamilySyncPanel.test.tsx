import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { FamilySyncPanel } from './FamilySyncPanel'
import type { FamilySyncAdapter, FamilySyncSnapshot } from './types'

function createAdapter(initialSnapshot: FamilySyncSnapshot) {
  let snapshot = initialSnapshot
  const adapter: FamilySyncAdapter = {
    loadSnapshot: vi.fn(async () => snapshot),
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

const members = [
  { id: person.id, displayName: person.displayName, avatarUrl: null, role: 'owner' as const, isCurrentUser: true },
  { id: '20000000-0000-4000-8000-000000000002', displayName: 'Shaymaa', avatarUrl: 'https://example.com/avatar.jpg', role: 'member' as const, isCurrentUser: false },
]

const connectedSnapshot: Extract<FamilySyncSnapshot, { kind: 'connected' }> = {
  kind: 'connected',
  person,
  circle: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Ahmed family',
    role: 'owner',
    memberCount: members.length,
    shareCode: 'BUB-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
  },
  pendingRequests: [],
  members,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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
        members,
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
        members,
      })
    })

    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    const codeInput = await screen.findByLabelText('Family code')
    expect(codeInput).toHaveAttribute('autocorrect', 'off')
    expect(codeInput).toHaveAttribute('enterkeyhint', 'go')
    await user.type(codeInput, code)
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

  it('coalesces rapid pending-membership refresh taps into one request', async () => {
    const pendingSnapshot: FamilySyncSnapshot = {
      kind: 'unjoined',
      person,
      pendingRequest: {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        createdAt: '2026-08-26T12:00:00.000Z',
      },
    }
    const setup = createAdapter(pendingSnapshot)
    let resolveRefresh:
      | ((snapshot: FamilySyncSnapshot) => void)
      | undefined
    vi.mocked(setup.adapter.loadSnapshot)
      .mockResolvedValueOnce(pendingSnapshot)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve
          }),
      )

    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    const checkAgain = await screen.findByRole('button', {
      name: 'Check again',
    })

    fireEvent.click(checkAgain)
    fireEvent.click(checkAgain)

    expect(setup.adapter.loadSnapshot).toHaveBeenCalledTimes(2)
    expect(
      screen.getByRole('button', { name: 'Checking…' }),
    ).toBeDisabled()

    await act(async () => resolveRefresh?.(pendingSnapshot))
    expect(
      await screen.findByRole('button', { name: 'Check again' }),
    ).toBeEnabled()
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
      members,
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
      members,
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
      members,
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

  it('shows actual members, roles and You, with an initials fallback for a failed portrait', async () => {
    const setup = createAdapter(connectedSnapshot)
    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    const roster = await screen.findByRole('region', { name: 'Your family' })
    expect(within(roster).getAllByRole('listitem')).toHaveLength(2)
    expect(within(roster).getByText('Simreen')).toBeInTheDocument()
    expect(within(roster).getByText('Shaymaa')).toBeInTheDocument()
    expect(within(roster).getByText('You')).toBeInTheDocument()
    expect(within(roster).getByText('Owner')).toBeInTheDocument()
    expect(within(roster).getByText('Member')).toBeInTheDocument()
    const portrait = roster.querySelector('img')!
    expect(portrait).toHaveAttribute('loading', 'lazy')
    fireEvent.error(portrait)
    expect(roster.querySelector('img')).toBeNull()
    expect(within(roster).getAllByText('S')).toHaveLength(2)
    expect(within(roster).queryByText(person.email)).toBeNull()
  })

  it('latches rapid rotation taps and publishes the returned code without a stale second read', async () => {
    const setup = createAdapter(connectedSnapshot)
    const rotation = deferred<string>()
    setup.adapter.rotateFamilyCode = vi.fn(() => rotation.promise)
    const callback = vi.fn()
    renderPanel(<FamilySyncPanel adapter={setup.adapter} onSnapshotChange={callback} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Replace family code' }))
    const confirm = screen.getByRole('button', { name: 'Create new code' })
    act(() => {
      fireEvent.click(confirm)
      fireEvent.click(confirm)
    })
    expect(setup.adapter.rotateFamilyCode).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Keep code' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeDisabled()
    expect(screen.getByRole('region', { name: 'Family Sync' })).toHaveAttribute('aria-busy', 'false')
    const newCode = 'BUB-1111-2222-3333-4444-5555-6666'
    await act(async () => rotation.resolve(newCode))
    expect(await screen.findByText(newCode)).toBeInTheDocument()
    expect(screen.queryByText(connectedSnapshot.circle.shareCode)).toBeNull()
    expect(setup.adapter.loadSnapshot).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenLastCalledWith({ ...connectedSnapshot, circle: { ...connectedSnapshot.circle, shareCode: newCode } })
  })

  it('keeps a failed rotation error local and allows a deliberate retry', async () => {
    const user = userEvent.setup()
    const setup = createAdapter(connectedSnapshot)
    const nextCode = 'BUB-1111-2222-3333-4444-5555-6666'
    setup.adapter.rotateFamilyCode = vi.fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(nextCode)
    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    await user.click(await screen.findByRole('button', { name: 'Replace family code' }))
    await user.click(screen.getByRole('button', { name: 'Create new code' }))
    const confirmation = screen.getByRole('group', { name: 'Confirm family code rotation' })
    expect(await within(confirmation).findByRole('alert')).toHaveTextContent(/could not reach the server/i)
    expect(screen.getByText(connectedSnapshot.circle.shareCode)).toBeInTheDocument()
    expect(screen.queryByText(/previous code no longer works/i)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Create new code' }))
    expect(await screen.findByText(nextCode)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(setup.adapter.rotateFamilyCode).toHaveBeenCalledTimes(2)
  })

  it.each(['not-a-code', connectedSnapshot.circle.shareCode])('does not announce a successful rotation for an unconfirmed result: %s', async (result) => {
    const setup = createAdapter(connectedSnapshot)
    setup.adapter.rotateFamilyCode = vi.fn(async () => result)
    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Replace family code' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create new code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be confirmed/i)
    expect(screen.queryByText(/previous code no longer works/i)).toBeNull()
    expect(screen.getByText(connectedSnapshot.circle.shareCode)).toBeInTheDocument()
  })

  it('clears the old family immediately on auth change and ignores its deferred rotation', async () => {
    const setup = createAdapter(connectedSnapshot)
    const rotation = deferred<string>()
    const newFamilyLoad = deferred<FamilySyncSnapshot>()
    let authChanged!: () => void
    setup.adapter.subscribeToAuthChanges = (callback) => { authChanged = callback; return vi.fn() }
    setup.adapter.rotateFamilyCode = vi.fn(() => rotation.promise)
    setup.adapter.loadSnapshot = vi.fn()
      .mockResolvedValueOnce(connectedSnapshot)
      .mockReturnValueOnce(newFamilyLoad.promise)
    const callback = vi.fn()
    renderPanel(<FamilySyncPanel adapter={setup.adapter} onSnapshotChange={callback} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Replace family code' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create new code' }))
    act(() => authChanged())
    expect(screen.queryByText(connectedSnapshot.circle.shareCode)).toBeNull()
    expect(screen.queryByRole('group', { name: 'Confirm family code rotation' })).toBeNull()
    const otherFamily: FamilySyncSnapshot = {
      ...connectedSnapshot,
      person: { ...person, id: 'different-account', displayName: 'Hishaam' },
      circle: { ...connectedSnapshot.circle, id: 'different-family', name: 'Another family', shareCode: 'BUB-1234-1234-1234-1234-1234-1234', role: 'member' },
      members: [],
    }
    await act(async () => newFamilyLoad.resolve(otherFamily))
    await act(async () => rotation.resolve('BUB-1111-2222-3333-4444-5555-6666'))
    expect(screen.getByRole('heading', { name: 'Another family' })).toBeInTheDocument()
    expect(screen.getByText(otherFamily.circle.shareCode)).toBeInTheDocument()
    expect(screen.queryByText(/previous code no longer works/i)).toBeNull()
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback).toHaveBeenLastCalledWith(otherFamily)
  })

  it('ignores a deferred rotation after navigation unmounts the panel', async () => {
    const setup = createAdapter(connectedSnapshot)
    const rotation = deferred<string>()
    setup.adapter.rotateFamilyCode = vi.fn(() => rotation.promise)
    const callback = vi.fn()
    const view = renderPanel(<FamilySyncPanel adapter={setup.adapter} onSnapshotChange={callback} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Replace family code' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create new code' }))
    view.unmount()
    await act(async () => rotation.resolve('BUB-1111-2222-3333-4444-5555-6666'))
    expect(callback).toHaveBeenCalledTimes(1)
    expect(setup.adapter.loadSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does not let a late old-family snapshot overwrite a newer authenticated snapshot', async () => {
    const setup = createAdapter(connectedSnapshot)
    const staleLoad = deferred<FamilySyncSnapshot>()
    let authChanged!: () => void
    setup.adapter.subscribeToAuthChanges = (callback) => { authChanged = callback; return vi.fn() }
    setup.adapter.loadSnapshot = vi.fn().mockReturnValueOnce(staleLoad.promise).mockResolvedValueOnce({ kind: 'signed-out' })
    const callback = vi.fn()
    renderPanel(<FamilySyncPanel adapter={setup.adapter} onSnapshotChange={callback} />)
    await waitFor(() => expect(setup.adapter.loadSnapshot).toHaveBeenCalledTimes(1))
    act(() => authChanged())
    await screen.findByRole('heading', { name: 'Keep your family close' })
    await act(async () => staleLoad.resolve(connectedSnapshot))
    expect(screen.queryByText(connectedSnapshot.circle.shareCode)).toBeNull()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('does not reload when the parent supplies a new snapshot callback', async () => {
    const setup = createAdapter(connectedSnapshot)
    const view = renderPanel(<FamilySyncPanel adapter={setup.adapter} onSnapshotChange={() => undefined} />)
    await screen.findByRole('heading', { name: 'Ahmed family' })
    const nextCallback = vi.fn()
    view.rerender(<MemoryRouter><FamilySyncPanel adapter={setup.adapter} onSnapshotChange={nextCallback} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(nextCallback).toHaveBeenCalledTimes(1))
    expect(setup.adapter.loadSnapshot).toHaveBeenCalledTimes(2)
  })

  it('releases a replaced adapter and ignores its unfinished family load', async () => {
    const previous = createAdapter(connectedSnapshot)
    const replacement = createAdapter({ kind: 'signed-out' })
    const staleLoad = deferred<FamilySyncSnapshot>()
    const unsubscribePrevious = vi.fn()
    const unsubscribeReplacement = vi.fn()
    previous.adapter.loadSnapshot = vi.fn(() => staleLoad.promise)
    previous.adapter.subscribeToAuthChanges = vi.fn(() => unsubscribePrevious)
    replacement.adapter.subscribeToAuthChanges = vi.fn(() => unsubscribeReplacement)
    const onSnapshotChange = vi.fn()
    const view = renderPanel(
      <FamilySyncPanel adapter={previous.adapter} onSnapshotChange={onSnapshotChange} />,
    )
    await waitFor(() => expect(previous.adapter.loadSnapshot).toHaveBeenCalledTimes(1))

    view.rerender(
      <MemoryRouter>
        <FamilySyncPanel adapter={replacement.adapter} onSnapshotChange={onSnapshotChange} />
      </MemoryRouter>,
    )
    await screen.findByRole('heading', { name: 'Keep your family close' })
    expect(unsubscribePrevious).toHaveBeenCalledTimes(1)
    expect(unsubscribeReplacement).not.toHaveBeenCalled()

    await act(async () => staleLoad.resolve(connectedSnapshot))
    expect(screen.queryByText(connectedSnapshot.circle.shareCode)).toBeNull()
    expect(onSnapshotChange).toHaveBeenCalledExactlyOnceWith({ kind: 'signed-out' })
    expect(replacement.adapter.loadSnapshot).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(unsubscribeReplacement).toHaveBeenCalledTimes(1)
  })

  it('does not report a successful create when the following snapshot could not be refreshed', async () => {
    const user = userEvent.setup()
    const setup = createAdapter({ kind: 'unjoined', person, pendingRequest: null })
    const create = deferred<void>()
    setup.adapter.createCircle = vi.fn(() => create.promise)
    setup.adapter.loadSnapshot = vi.fn()
      .mockResolvedValueOnce({ kind: 'unjoined', person, pendingRequest: null })
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(connectedSnapshot)
    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    await user.type(await screen.findByLabelText('Family group name'), 'Ahmed family')
    const form = screen.getByRole('button', { name: 'Create family group' }).closest('form')!
    act(() => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })
    expect(setup.adapter.createCircle).toHaveBeenCalledTimes(1)
    await act(async () => create.resolve())
    expect(await screen.findByRole('alert')).toHaveTextContent(/change was sent, but we could not refresh/i)
    expect(screen.queryByText(/is ready\. Your family code/i)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByRole('heading', { name: 'Ahmed family' })).toBeInTheDocument()
    expect(setup.adapter.createCircle).toHaveBeenCalledTimes(1)
  })

  it('ignores a late sharing response after sign-out and blocks duplicate sharing taps', async () => {
    const setup = createAdapter(connectedSnapshot)
    const share = deferred<'shared'>()
    const shareCode = vi.fn(() => share.promise)
    let authChanged!: () => void
    setup.adapter.subscribeToAuthChanges = (callback) => { authChanged = callback; return vi.fn() }
    renderPanel(<FamilySyncPanel adapter={setup.adapter} shareCode={shareCode} />)
    const button = await screen.findByRole('button', { name: 'Share family code for Ahmed family' })
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(shareCode).toHaveBeenCalledTimes(1)
    setup.setSnapshot({ kind: 'signed-out' })
    act(() => authChanged())
    await screen.findByRole('heading', { name: 'Keep your family close' })
    await act(async () => share.resolve('shared'))
    expect(screen.queryByText(/ready in the share sheet/i)).toBeNull()
    expect(screen.queryByText(connectedSnapshot.circle.shareCode)).toBeNull()
  })

  it('recovers from a failed initial load without duplicating a rapid retry', async () => {
    const setup = createAdapter(connectedSnapshot)
    const retry = deferred<FamilySyncSnapshot>()
    setup.adapter.loadSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockReturnValueOnce(retry.promise)
    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    const button = await screen.findByRole('button', { name: 'Check again' })
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(setup.adapter.loadSnapshot).toHaveBeenCalledTimes(2)
    await act(async () => retry.resolve(connectedSnapshot))
    expect(await screen.findByRole('region', { name: 'Your family' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not claim a family join succeeded when a stale refresh still says unjoined', async () => {
    const user = userEvent.setup()
    const setup = createAdapter({ kind: 'unjoined', person, pendingRequest: null })
    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    await user.type(await screen.findByLabelText('Family code'), connectedSnapshot.circle.shareCode)
    await user.click(screen.getByRole('button', { name: 'Join family' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/have not updated yet/i)
    expect(screen.queryByText('You are now connected to your family.')).toBeNull()
  })

  it.each([
    new Error('family_access_changed'),
    new Error('account_changed'),
    { code: '42501', message: 'Permission denied' },
    { status: 403, message: 'Forbidden' },
  ])('discards the previous roster and code when refreshed access is rejected: %j', async (reason) => {
    const setup = createAdapter(connectedSnapshot)
    setup.adapter.loadSnapshot = vi.fn()
      .mockResolvedValueOnce(connectedSnapshot)
      .mockRejectedValueOnce(reason)
      .mockResolvedValueOnce({ kind: 'signed-out' })
    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }))
    await screen.findByRole('alert')
    expect(screen.queryByText(connectedSnapshot.circle.shareCode)).toBeNull()
    expect(screen.queryByRole('region', { name: 'Your family' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Replace family code' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByRole('heading', { name: 'Keep your family close' })).toBeInTheDocument()
  })

  it('retains the family through a temporary network refresh failure', async () => {
    const setup = createAdapter(connectedSnapshot)
    setup.adapter.loadSnapshot = vi.fn()
      .mockResolvedValueOnce(connectedSnapshot)
      .mockRejectedValueOnce(new Error('network unavailable'))
    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }))
    await screen.findByRole('alert')
    expect(screen.getByText(connectedSnapshot.circle.shareCode)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Your family' })).toBeInTheDocument()
  })

  it('clears stale owner actions when a rotation discovers changed permissions', async () => {
    const setup = createAdapter(connectedSnapshot)
    setup.adapter.rotateFamilyCode = vi.fn().mockRejectedValueOnce(new Error('owner_required'))
    renderPanel(<FamilySyncPanel adapter={setup.adapter} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Replace family code' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create new code' }))
    await screen.findByRole('alert')
    expect(screen.queryByText(connectedSnapshot.circle.shareCode)).toBeNull()
    expect(screen.queryByRole('group', { name: 'Confirm family code rotation' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })
})
