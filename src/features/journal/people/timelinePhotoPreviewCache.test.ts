import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMemberSessionCaches } from '../../../app/memberSessionCache'
import { acquireTimelinePhotoPreview, peekTimelinePhotoPreview } from './timelinePhotoPreviewCache'

const create = vi.fn((_source: Blob) => `blob:preview-${create.mock.calls.length}`)
const revoke = vi.fn()
const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL

beforeEach(() => {
  vi.useFakeTimers()
  create.mockClear()
  revoke.mockClear()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
})

afterEach(() => {
  clearMemberSessionCaches()
  vi.useRealTimers()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke })
})

describe('bounded Journal preview reuse', () => {
  it('never allocates on peek and shares one URL across rail, album and return visits', () => {
    const source = new Blob(['portrait'])
    expect(peekTimelinePhotoPreview('member:family', source)).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
    const rail = acquireTimelinePhotoPreview('member:family', source)
    const album = acquireTimelinePhotoPreview('member:family', source)
    expect(album.url).toBe(rail.url)
    rail.release()
    album.release()
    for (let visit = 0; visit < 20; visit += 1) {
      const returned = acquireTimelinePhotoPreview('member:family', source)
      expect(returned.url).toBe(rail.url)
      returned.release()
    }
    expect(create).toHaveBeenCalledTimes(1)
    expect(revoke).not.toHaveBeenCalled()
  })

  it('expires idle previews but never revokes one still on screen', () => {
    const source = new Blob(['portrait'])
    const first = acquireTimelinePhotoPreview('member:family', source)
    const second = acquireTimelinePhotoPreview('member:family', source)
    first.release()
    first.release()
    vi.advanceTimersByTime(120_000)
    expect(revoke).not.toHaveBeenCalled()
    second.release()
    vi.advanceTimersByTime(59_999)
    expect(peekTimelinePhotoPreview('member:family', source)).toBe(second.url)
    vi.advanceTimersByTime(1)
    expect(revoke).toHaveBeenCalledWith(second.url)
    expect(peekTimelinePhotoPreview('member:family', source)).toBeUndefined()
  })

  it('bounds idle count and bytes, keeping active URLs until their owner releases', () => {
    const activeSource = new Blob(['active'])
    const active = acquireTimelinePhotoPreview('member:family', activeSource)
    const oldSource = new Blob(['old'])
    const old = acquireTimelinePhotoPreview('member:family', oldSource)
    old.release()
    for (let index = 0; index < 12; index += 1) {
      acquireTimelinePhotoPreview('member:family', new Blob([String(index)])).release()
    }
    expect(peekTimelinePhotoPreview('member:family', oldSource)).toBeUndefined()
    expect(peekTimelinePhotoPreview('member:family', activeSource)).toBe(active.url)
    const large = new Blob(['large'])
    Object.defineProperty(large, 'size', { value: 25 * 1024 * 1024 })
    const largePreview = acquireTimelinePhotoPreview('member:family', large)
    expect(revoke).not.toHaveBeenCalledWith(largePreview.url)
    largePreview.release()
    expect(peekTimelinePhotoPreview('member:family', large)).toBeUndefined()
    expect(peekTimelinePhotoPreview('member:family', activeSource)).toBe(active.url)
    active.release()
  })

  it('cancels the old expiry when the image is reused before its idle deadline', () => {
    const source = new Blob(['portrait'])
    acquireTimelinePhotoPreview('member:family', source).release()
    vi.advanceTimersByTime(59_000)
    const reused = acquireTimelinePhotoPreview('member:family', source)
    vi.advanceTimersByTime(60_000)
    expect(revoke).not.toHaveBeenCalled()
    reused.release()
    vi.advanceTimersByTime(60_000)
    expect(revoke).toHaveBeenCalledExactlyOnceWith(reused.url)
  })

  it('revokes private URLs on account reset and does not reuse them in another family', () => {
    const source = new Blob(['private'])
    const old = acquireTimelinePhotoPreview('old:family', source)
    clearMemberSessionCaches('unrelated:family')
    expect(revoke).not.toHaveBeenCalled()
    clearMemberSessionCaches('old:family')
    expect(revoke).toHaveBeenCalledWith(old.url)
    expect(peekTimelinePhotoPreview('old:family', source)).toBeUndefined()
    const next = acquireTimelinePhotoPreview('new:family', source)
    expect(next.url).not.toBe(old.url)
    old.release()
    expect(peekTimelinePhotoPreview('new:family', source)).toBe(next.url)
    next.release()
    clearMemberSessionCaches()
    vi.runAllTimers()
    expect(revoke).toHaveBeenCalledTimes(2)
  })
})
