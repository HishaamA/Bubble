import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMemberSessionCaches } from '../../app/memberSessionCache'
import {
  getCapsuleSession,
  isCapsuleSessionFresh,
  refreshCapsuleSession,
  type CapsuleSyncResult,
} from './capsuleSessionCache'

const now = new Date(2026, 8, 11, 12)
const result: CapsuleSyncResult = { capsules: [], authoritativeWeeklyId: 'week-a' }

beforeEach(() => {
  clearMemberSessionCaches()
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => vi.useRealTimers())

describe('Capsule session data', () => {
  it('coalesces a refresh across route remounts and reuses its warm snapshot', async () => {
    const first = getCapsuleSession('member:family')
    let resolve!: (value: CapsuleSyncResult) => void
    const work = vi.fn(() => new Promise<CapsuleSyncResult>((done) => { resolve = done }))
    const pending = refreshCapsuleSession(first, now, work)
    const remounted = getCapsuleSession('member:family')
    expect(refreshCapsuleSession(remounted, now, work)).toBe(pending)
    expect(work).toHaveBeenCalledTimes(1)
    resolve(result)
    await pending
    expect(remounted.result).toBe(result)
    expect(isCapsuleSessionFresh(remounted, now)).toBe(true)
    vi.advanceTimersByTime(30_000)
    expect(isCapsuleSessionFresh(remounted, new Date())).toBe(false)
  })

  it('refreshes a newly due reveal even during the rapid-tab reuse window', async () => {
    const session = getCapsuleSession('member:family')
    const reveal = new Date(now.getTime() + 10_000)
    await refreshCapsuleSession(session, now, async () => ({
      ...result,
      capsules: [{
        id: 'special-one', kind: 'special', title: 'Family day',
        createdAt: now.toISOString(), closesAt: reveal.toISOString(), opensAt: reveal.toISOString(),
        createdByName: 'Family', photos: [], familySynced: true,
      }],
    }))
    expect(isCapsuleSessionFresh(session, now)).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(isCapsuleSessionFresh(session, new Date())).toBe(false)
  })

  it('does not revive a cleared account when its previous request completes', async () => {
    const previous = getCapsuleSession('member:old-family')
    let resolve!: (value: CapsuleSyncResult) => void
    const pending = refreshCapsuleSession(previous, now, () => new Promise((done) => { resolve = done }))
    clearMemberSessionCaches('member:old-family')
    const current = getCapsuleSession('member:new-family')
    resolve(result)
    await pending
    expect(previous.disposed).toBe(true)
    expect(previous.result).toBeUndefined()
    expect(current.result).toBeUndefined()
    expect(getCapsuleSession('member:new-family')).toBe(current)
    expect(getCapsuleSession('member:old-family').result).toBeUndefined()
  })

  it('starts cold after a family change and does not revive an earlier family', async () => {
    const previous = getCapsuleSession('member:family-a')
    await refreshCapsuleSession(previous, now, async () => result)
    expect(getCapsuleSession('member:family-b').result).toBeUndefined()
    expect(previous.disposed).toBe(true)
    expect(getCapsuleSession('member:family-a').result).toBeUndefined()
  })
})
