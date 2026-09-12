import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeToAppResume } from './appResume'

const native = vi.hoisted(() => ({ addListener: vi.fn() }))
vi.mock('@capacitor/app', () => ({ App: native }))

afterEach(() => vi.restoreAllMocks())

describe('family feed resume events', () => {
  it('coalesces browser focus/online/visibility and ignores hidden documents', async () => {
    native.addListener.mockResolvedValue({ remove: vi.fn() })
    const refresh = vi.fn()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const stop = subscribeToAppResume(refresh)
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('hidden')
    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(1)
    stop()
  })

  it('refreshes for native iOS/Android foregrounding but not backgrounding', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    native.addListener.mockResolvedValue({ remove })
    const refresh = vi.fn()
    const stop = subscribeToAppResume(refresh)
    const callback = native.addListener.mock.calls.at(-1)![1] as (state: { isActive: boolean }) => void
    callback({ isActive: false })
    await Promise.resolve()
    expect(refresh).not.toHaveBeenCalled()
    callback({ isActive: true })
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledOnce()
    stop()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('cancels queued refreshes and removes a native listener that arrives after unmount', async () => {
    let finish!: (value: { remove: () => Promise<void> }) => void
    native.addListener.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const refresh = vi.fn()
    const remove = vi.fn().mockResolvedValue(undefined)
    const stop = subscribeToAppResume(refresh)
    window.dispatchEvent(new Event('focus'))
    stop()
    finish({ remove })
    await Promise.resolve()
    expect(refresh).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('keeps browser refresh working when the native plugin is unavailable', async () => {
    native.addListener.mockRejectedValue(new Error('Unavailable'))
    const refresh = vi.fn()
    const stop = subscribeToAppResume(refresh)
    await Promise.resolve()
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledOnce()
    stop()
  })
})
