import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'

const mocks = vi.hoisted(() => ({
  status: 'signed-in',
  scheduled: undefined as undefined | ((route: string) => Promise<unknown>),
  loadJournal: vi.fn(), warmPeople: vi.fn(), loadOther: vi.fn(), cancel: vi.fn(),
}))
vi.mock('../features/auth/authContext', () => ({ useAuth: () => ({ status: mocks.status }) }))
vi.mock('./AppTabBar', () => ({ AppTabBar: () => null }))
vi.mock('./primaryRoutePreload', () => ({
  loadJournalRoute: mocks.loadJournal,
  loadJournalPreparation: async () => ({ preloadPeopleTimelineSession: mocks.warmPeople }),
  preloadPrimaryRoute: mocks.loadOther,
  schedulePrimaryRoutePreloads: (_path: string, load: (route: string) => Promise<unknown>) => {
    mocks.scheduled = load
    return mocks.cancel
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.status = 'signed-in'
  mocks.scheduled = undefined
  mocks.loadJournal.mockResolvedValue({ preloadJournalPeople: mocks.warmPeople })
})
afterEach(cleanup)

function shell(namespace?: string) {
  return <MemoryRouter initialEntries={['/capsule']}>
    <AppShell memberCacheNamespace={namespace}><p>Test screen</p></AppShell>
  </MemoryRouter>
}

describe('quiet Journal preparation', () => {
  it('warms local People data only after the existing idle route import', async () => {
    render(shell('member:family'))
    expect(mocks.loadJournal).not.toHaveBeenCalled()
    expect(mocks.warmPeople).not.toHaveBeenCalled()
    await act(async () => { await mocks.scheduled?.('/journal') })
    expect(mocks.warmPeople).toHaveBeenCalledExactlyOnceWith('member:family')
    await act(async () => { await mocks.scheduled?.('/') })
    expect(mocks.loadOther).toHaveBeenCalledWith('/')
    expect(mocks.warmPeople).toHaveBeenCalledTimes(1)
  })

  it('never revives an old member cache when its lazy import resolves after departure', async () => {
    let resolve!: (module: { preloadJournalPeople: typeof mocks.warmPeople }) => void
    mocks.loadJournal.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const view = render(shell('old:family'))
    const pending = mocks.scheduled?.('/journal')
    view.rerender(shell('new:family'))
    await act(async () => {
      resolve({ preloadJournalPeople: mocks.warmPeople })
      await pending
    })
    expect(mocks.cancel).toHaveBeenCalled()
    expect(mocks.warmPeople).not.toHaveBeenCalled()
    await act(async () => { await mocks.scheduled?.('/journal') })
    expect(mocks.warmPeople).toHaveBeenCalledExactlyOnceWith('new:family')
  })

  it('does not read private metadata without a namespace or signed-in shell', async () => {
    const view = render(shell())
    await act(async () => { await mocks.scheduled?.('/journal') })
    expect(mocks.loadOther).toHaveBeenCalledWith('/journal')
    expect(mocks.warmPeople).not.toHaveBeenCalled()
    view.unmount()
    mocks.status = 'signed-out'
    mocks.scheduled = undefined
    render(shell('old:family'))
    expect(mocks.scheduled).toBeUndefined()
  })
})
