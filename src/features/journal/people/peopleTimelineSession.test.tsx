import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMemberSessionCaches } from '../../../app/memberSessionCache'
import { PeopleTimeline } from './PeopleTimeline'
import { preloadPeopleTimelineSession, usePeopleTimelineSession } from './peopleTimelineSession'
import { emptyPeopleTimelineState, loadPeopleTimelineState, savePeopleTimelineState } from './peopleTimelineStore'
import { ALL_PHOTOS_PERSON_ID, type PeopleTimelineState } from './types'

vi.mock('./faceRecognition', () => ({ scanReferencePortrait: vi.fn(), scanTimelineFaces: vi.fn() }))
vi.mock('./peopleTimelineStore', async (original) => ({
  ...await original<typeof import('./peopleTimelineStore')>(),
  loadPeopleTimelineState: vi.fn(),
  savePeopleTimelineState: vi.fn(),
}))

function state(name: string): PeopleTimelineState {
  return {
    ...emptyPeopleTimelineState(),
    people: [{ id: name, name, createdAt: '2026-01-01T00:00:00Z' }],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  clearMemberSessionCaches()
  vi.resetAllMocks()
  vi.mocked(loadPeopleTimelineState).mockResolvedValue(state('Maya'))
  vi.mocked(savePeopleTimelineState).mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  clearMemberSessionCaches()
})

describe('People timeline warm session', () => {
  it('renders prewarmed metadata immediately without a second storage read', async () => {
    const pending = deferred<PeopleTimelineState>()
    vi.mocked(loadPeopleTimelineState).mockReturnValue(pending.promise)
    const prewarm = preloadPeopleTimelineSession('maya:family')
    expect(preloadPeopleTimelineSession('maya:family')).toBe(prewarm)
    pending.resolve(state('Maya'))
    await prewarm
    const view = renderHook(() => usePeopleTimelineSession('maya:family'))
    expect(view.result.current.ready).toBe(true)
    expect(view.result.current.state.people[0].name).toBe('Maya')
    expect(loadPeopleTimelineState).toHaveBeenCalledExactlyOnceWith('maya:family')
    expect(savePeopleTimelineState).not.toHaveBeenCalled()
  })

  it('shows people synchronously on return without reading or rewriting unchanged storage', async () => {
    const view = () => render(<MemoryRouter><PeopleTimeline
      photos={[]}
      cacheNamespace="maya:family"
      initialPersonId={ALL_PHOTOS_PERSON_ID}
    /></MemoryRouter>)
    const first = view()
    await screen.findByRole('button', { name: 'Maya, face photo needed' })
    expect(savePeopleTimelineState).not.toHaveBeenCalled()
    first.unmount()
    view()
    expect(screen.getByRole('button', { name: 'Maya, face photo needed' })).toBeInTheDocument()
    expect(screen.queryByText(/Loading people/)).not.toBeInTheDocument()
    expect(loadPeopleTimelineState).toHaveBeenCalledExactlyOnceWith('maya:family')
    expect(savePeopleTimelineState).not.toHaveBeenCalled()
  })

  it('coalesces cold hydration across consumers, StrictMode and quick remounts', async () => {
    const pending = deferred<PeopleTimelineState>()
    vi.mocked(loadPeopleTimelineState).mockReturnValue(pending.promise)
    const first = renderHook(() => usePeopleTimelineSession('maya:family'), { wrapper: StrictMode })
    const second = renderHook(() => usePeopleTimelineSession('maya:family'))
    expect(first.result.current.ready).toBe(false)
    expect(loadPeopleTimelineState).toHaveBeenCalledTimes(1)
    first.unmount()
    await act(async () => { pending.resolve(state('Maya')) })
    expect(second.result.current.ready).toBe(true)
    second.unmount()
    const returning = renderHook(() => usePeopleTimelineSession('maya:family'))
    expect(returning.result.current.state.people[0].name).toBe('Maya')
    expect(returning.result.current.ready).toBe(true)
    expect(loadPeopleTimelineState).toHaveBeenCalledTimes(1)
  })

  it('preserves a local edit immediately across remounts while its save is still pending', async () => {
    const slowSave = deferred<boolean>()
    vi.mocked(savePeopleTimelineState).mockReturnValue(slowSave.promise)
    const first = renderHook(() => usePeopleTimelineSession('maya:family'))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    const edited = state('Renamed Maya')
    act(() => {
      first.result.current.replace(edited)
      void first.result.current.save(edited)
    })
    first.unmount()
    const returning = renderHook(() => usePeopleTimelineSession('maya:family'))
    expect(returning.result.current.state).toBe(edited)
    expect(returning.result.current.ready).toBe(true)
    expect(loadPeopleTimelineState).toHaveBeenCalledTimes(1)
    await act(async () => { slowSave.resolve(true) })
  })

  it('serializes writes across remounts and coalesces repeated checkpoints', async () => {
    const slowSave = deferred<boolean>()
    vi.mocked(savePeopleTimelineState).mockReturnValueOnce(slowSave.promise)
    const first = renderHook(() => usePeopleTimelineSession('maya:family'))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    const editA = state('First'), editB = state('Second')
    let checkpoint!: Promise<boolean>
    act(() => {
      first.result.current.replace(editA)
      checkpoint = first.result.current.save(editA)
      expect(first.result.current.save(editA)).toBe(checkpoint)
    })
    await waitFor(() => expect(savePeopleTimelineState).toHaveBeenCalledTimes(1))
    first.unmount()
    const returning = renderHook(() => usePeopleTimelineSession('maya:family'))
    act(() => {
      returning.result.current.replace(editB)
      void returning.result.current.save(editB)
    })
    expect(savePeopleTimelineState).toHaveBeenCalledTimes(1)
    await act(async () => { slowSave.resolve(true); await checkpoint })
    await waitFor(() => expect(savePeopleTimelineState).toHaveBeenCalledTimes(2))
    expect(vi.mocked(savePeopleTimelineState).mock.calls.map(([, value]) => value)).toEqual([editA, editB])
  })

  it('retries failed storage without losing the usable in-memory edit', async () => {
    vi.mocked(savePeopleTimelineState).mockResolvedValueOnce(false).mockResolvedValue(true)
    const view = renderHook(() => usePeopleTimelineSession('maya:family'))
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    const edited = state('Edited')
    act(() => { view.result.current.replace(edited) })
    await expect(view.result.current.save(edited)).resolves.toBe(false)
    expect(view.result.current.state).toBe(edited)
    await expect(view.result.current.save(edited)).resolves.toBe(true)
    expect(savePeopleTimelineState).toHaveBeenCalledTimes(2)
  })

  it('never displays the previous family snapshot when namespace changes', async () => {
    const nextFamily = deferred<PeopleTimelineState>()
    vi.mocked(loadPeopleTimelineState).mockResolvedValueOnce(state('Previous family')).mockReturnValue(nextFamily.promise)
    const view = renderHook(({ namespace }) => usePeopleTimelineSession(namespace), {
      initialProps: { namespace: 'maya:previous' },
    })
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    view.rerender({ namespace: 'maya:next' })
    expect(view.result.current.ready).toBe(false)
    expect(view.result.current.state.people).toEqual([])
    await act(async () => { nextFamily.resolve(state('Next family')) })
    expect(view.result.current.state.people[0].name).toBe('Next family')
  })

  it('invalidates late reads on sign-out and clears private snapshots immediately', async () => {
    const late = deferred<PeopleTimelineState>()
    vi.mocked(loadPeopleTimelineState).mockReturnValueOnce(late.promise).mockResolvedValue(state('Fresh session'))
    const old = renderHook(() => usePeopleTimelineSession('maya:family'))
    act(() => { clearMemberSessionCaches('maya:family') })
    old.unmount()
    const fresh = renderHook(() => usePeopleTimelineSession('maya:family'))
    await waitFor(() => expect(fresh.result.current.ready).toBe(true))
    await act(async () => { late.resolve(state('Departed private data')) })
    expect(fresh.result.current.state.people[0].name).toBe('Fresh session')
    act(() => { clearMemberSessionCaches('maya:family') })
    expect(fresh.result.current.state.people).toEqual([])
    expect(fresh.result.current.ready).toBe(false)
  })

  it('ignores unrelated family resets but blocks old callbacks and queued writes after departure', async () => {
    const slowSave = deferred<boolean>()
    vi.mocked(savePeopleTimelineState).mockReturnValueOnce(slowSave.promise)
    const view = renderHook(() => usePeopleTimelineSession('maya:family'))
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    const old = view.result.current
    act(() => { clearMemberSessionCaches('someone:else') })
    expect(view.result.current.ready).toBe(true)
    const first = old.save(state('Started'))
    await waitFor(() => expect(savePeopleTimelineState).toHaveBeenCalledTimes(1))
    const queued = old.save(state('Queued'))
    act(() => { clearMemberSessionCaches('maya:family') })
    expect(old.replace(state('Late private edit'))).toBe(false)
    await expect(old.save(state('Late private edit'))).resolves.toBe(false)
    await act(async () => { slowSave.resolve(true); await first })
    await expect(queued).resolves.toBe(false)
    expect(savePeopleTimelineState).toHaveBeenCalledTimes(1)
    expect(view.result.current.state.people).toEqual([])
  })
})
