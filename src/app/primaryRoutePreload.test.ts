import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { schedulePrimaryRoutePreloads } from './primaryRoutePreload'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestIdleCallback', undefined)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('primary route preloading', () => {
  it('waits for navigation to settle and imports one other destination at a time', async () => {
    let resolveFirst!: () => void
    const load = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue(undefined)
    const cancel = schedulePrimaryRoutePreloads('/journal/day/2026-09-11', load)
    await vi.advanceTimersByTimeAsync(599)
    expect(load).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledExactlyOnceWith('/')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(1)
    resolveFirst()
    await vi.advanceTimersByTimeAsync(600)
    expect(load).toHaveBeenNthCalledWith(2, '/capsule')
    cancel()
  })

  it('cancels preloads when the user switches tabs before settling', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const cancel = schedulePrimaryRoutePreloads('/', load)
    await vi.advanceTimersByTimeAsync(500)
    cancel()
    await vi.runAllTimersAsync()
    expect(load).not.toHaveBeenCalled()
  })

  it('does not schedule another chunk after an in-flight preload is cancelled', async () => {
    let resolve!: () => void
    const load = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    const cancel = schedulePrimaryRoutePreloads('/', load)
    await vi.advanceTimersByTimeAsync(600)
    cancel()
    resolve()
    await vi.runAllTimersAsync()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('leaves backgrounded apps idle and treats a preload error as non-blocking', async () => {
    const load = vi.fn().mockRejectedValue(new Error('Offline'))
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const cancelHidden = schedulePrimaryRoutePreloads('/', load)
    await vi.advanceTimersByTimeAsync(600)
    expect(load).not.toHaveBeenCalled()
    cancelHidden()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const cancelVisible = schedulePrimaryRoutePreloads('/', load)
    await vi.runAllTimersAsync()
    expect(load.mock.calls.map(([route]) => route)).toEqual(['/capsule', '/journal'])
    cancelVisible()
  })
})
