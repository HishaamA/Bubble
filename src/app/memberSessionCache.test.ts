import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMemberSessionCaches, createMemberSessionCache, retainMemberSessionCaches } from './memberSessionCache'

afterEach(() => clearMemberSessionCaches())

describe('member session cache', () => {
  it('keeps one namespace and disposes its pending work before replacing it', () => {
    const dispose = vi.fn()
    const cache = createMemberSessionCache<{ photos: string[] }>({ dispose })
    const first = { photos: ['private'] }
    cache.set('user:family-one', first)
    expect(cache.get('user:family-two')).toBeUndefined()
    cache.set('user:family-two', { photos: [] })
    expect(dispose).toHaveBeenCalledExactlyOnceWith(first)
    expect(cache.get('user:family-one')).toBeUndefined()
    clearMemberSessionCaches('user:family-one')
    expect(cache.get('user:family-two')).toEqual({ photos: [] })
  })

  it('clears all feature caches at the actual session boundary', async () => {
    const first = createMemberSessionCache<number>()
    const second = createMemberSessionCache<number>()
    const release = retainMemberSessionCaches('member')
    first.set('member', 1)
    second.set('member', 2)
    release()
    await Promise.resolve()
    expect(first.get('member')).toBeUndefined()
    expect(second.get('member')).toBeUndefined()
  })

  it('does not throw away warm state during StrictMode effect replay', async () => {
    const cache = createMemberSessionCache<number>()
    const firstRelease = retainMemberSessionCaches('member')
    cache.set('member', 1)
    firstRelease()
    const secondRelease = retainMemberSessionCaches('member')
    await Promise.resolve()
    expect(cache.get('member')).toBe(1)
    secondRelease()
    await Promise.resolve()
    expect(cache.get('member')).toBeUndefined()
  })
})
