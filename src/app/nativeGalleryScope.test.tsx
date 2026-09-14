import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(), retainScope: vi.fn(), platform: 'android',
  auth: { status: 'loading', user: null as null | { id: string } },
  family: { status: 'loading', snapshot: null as null | { kind: string; membership: { familyId: string } } },
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => mocks.platform, isPluginAvailable: () => true },
  registerPlugin: () => ({ cancel: mocks.cancel, retainScope: mocks.retainScope }),
}))
vi.mock('../features/auth', () => ({ useAuth: () => mocks.auth }))
vi.mock('../features/onboarding', () => ({ useFamilyOnboarding: () => mocks.family }))
vi.mock('../features/memories/shared', () => ({
  FamilyMomentSyncProvider: ({ children }: { children: ReactNode }) => children,
  SharedMomentsProvider: ({ children }: { children: ReactNode }) => children,
}))

import { AccountScopedData } from './AccountScopedData'
import { createAccountCacheNamespace } from './accountCacheNamespace'
import { clearMemberSessionCaches, retainMemberSessionCaches } from './memberSessionCache'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.cancel.mockResolvedValue(undefined); mocks.retainScope.mockResolvedValue(undefined)
  mocks.platform = 'android'
  mocks.auth = { status: 'loading', user: null }
  mocks.family = { status: 'loading', snapshot: null }
})
afterEach(async () => { cleanup(); await Promise.resolve(); clearMemberSessionCaches() })

describe('background gallery account boundary outside Journal', () => {
  it('waits through loading and preserves the resolved current member on cold launch', () => {
    const view = render(<AccountScopedData>Other tab</AccountScopedData>)
    expect(mocks.retainScope).not.toHaveBeenCalled()
    mocks.auth = { status: 'signed-in', user: { id: 'member-one' } }
    view.rerender(<AccountScopedData>Other tab</AccountScopedData>)
    expect(mocks.retainScope).not.toHaveBeenCalled()
    mocks.family = { status: 'member', snapshot: { kind: 'member', membership: { familyId: 'family-one' } } }
    view.rerender(<AccountScopedData>Other tab</AccountScopedData>)
    expect(mocks.retainScope).toHaveBeenCalledWith({ scope: createAccountCacheNamespace('member-one', 'family-one') })
  })

  it('invalidates old native ownership on a definitive signed-out cold launch', () => {
    mocks.auth.status = 'signed-out'
    render(<AccountScopedData>Sign in</AccountScopedData>)
    expect(mocks.retainScope).toHaveBeenCalledWith({ scope: 'signed-out:no-family' })
  })

  it('cancels departed native scope even when its Journal session never existed', async () => {
    const scope = createAccountCacheNamespace('member-one', 'family-one')
    const release = retainMemberSessionCaches(scope)
    release()
    await act(async () => { await Promise.resolve() })
    expect(mocks.cancel).toHaveBeenCalledWith({ scope })
  })

  it('does not treat StrictMode effect replay as native logout', async () => {
    const first = retainMemberSessionCaches('replay-member')
    first()
    const second = retainMemberSessionCaches('replay-member')
    await Promise.resolve()
    expect(mocks.cancel).not.toHaveBeenCalled()
    second()
    await Promise.resolve()
    expect(mocks.cancel).toHaveBeenCalledWith({ scope: 'replay-member' })
  })

  it('leaves iOS on the existing supported foreground path', () => {
    mocks.platform = 'ios'; mocks.auth.status = 'signed-out'
    render(<AccountScopedData>Sign in</AccountScopedData>)
    expect(mocks.retainScope).not.toHaveBeenCalled()
  })
})
