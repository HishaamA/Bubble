import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  capsuleVisibilityKey, hiddenContent, photoVisibilityKey,
  restoreHiddenContent, setContentHidden, useHiddenContent,
} from './contentVisibility'

let sequence = 0
let scope: string
const storageKey = (value: string) => `bubble:hidden-content:v1:${encodeURIComponent(value)}`

beforeEach(() => {
  localStorage.clear()
  scope = `visibility-owner:family:${++sequence}`
})
afterEach(() => vi.restoreAllMocks())

describe('personal content visibility', () => {
  it('distinguishes Capsule, Capsule photo and Journal photo keys with identical IDs', () => {
    expect(capsuleVisibilityKey('same-id')).toBe('capsule:same-id')
    expect(photoVisibilityKey('same-id', 'capsule-photo')).toBe('capsule-photo:same-id')
    expect(photoVisibilityKey('same-id', 'journal-photo')).toBe('journal-photo:same-id')
    setContentHidden(scope, photoVisibilityKey('same-id', 'journal-photo'), true)
    expect(hiddenContent(scope)).toEqual(['journal-photo:same-id'])
  })

  it('hides and restores only the chosen item without touching family source records', () => {
    localStorage.setItem('fake-family-photo-source', 'original source remains')
    const widgetChanged = vi.fn()
    window.addEventListener('bubble:widget-data-changed', widgetChanged)
    try {
      setContentHidden(scope, 'journal-photo:a', true)
      setContentHidden(scope, 'capsule:b', true)
      setContentHidden(scope, 'journal-photo:a', true)
      expect(hiddenContent(scope)).toEqual(['journal-photo:a', 'capsule:b'])
      setContentHidden(scope, 'journal-photo:a', false)
      expect(hiddenContent(scope)).toEqual(['capsule:b'])
      expect(widgetChanged).toHaveBeenCalledTimes(4)
      expect(localStorage.getItem('fake-family-photo-source')).toBe('original source remains')
    } finally { window.removeEventListener('bubble:widget-data-changed', widgetChanged) }
  })

  it('isolates hiding and restore-all across both accounts and families', () => {
    const otherFamily = `${scope}:other-family`
    const otherAccount = `other-account:${scope}`
    for (const target of [scope, otherFamily, otherAccount]) setContentHidden(target, 'capsule:same-id', true)
    restoreHiddenContent(scope)
    expect(hiddenContent(scope)).toEqual([])
    expect(hiddenContent(otherFamily)).toEqual(['capsule:same-id'])
    expect(hiddenContent(otherAccount)).toEqual(['capsule:same-id'])
    expect(localStorage.getItem(storageKey(scope))).toBeNull()
  })

  it('updates mounted readers immediately and switches scopes without flashing prior hidden items', () => {
    const nextScope = `${scope}:next`
    const hook = renderHook(({ current }) => useHiddenContent(current), { initialProps: { current: scope } })
    expect(hook.result.current).toEqual([])
    act(() => setContentHidden(scope, 'capsule:a', true))
    expect(hook.result.current).toEqual(['capsule:a'])
    hook.rerender({ current: nextScope })
    expect(hook.result.current).toEqual([])
    act(() => setContentHidden(scope, 'capsule:b', true))
    expect(hook.result.current).toEqual([])
    act(() => setContentHidden(nextScope, 'journal-photo:c', true))
    expect(hook.result.current).toEqual(['journal-photo:c'])
    act(() => restoreHiddenContent(nextScope))
    expect(hook.result.current).toEqual([])
  })

  it('accepts a same-origin storage update and keeps snapshots referentially stable between writes', () => {
    const hook = renderHook(() => useHiddenContent(scope))
    const initial = hook.result.current
    expect(hiddenContent(scope)).toBe(initial)
    act(() => {
      localStorage.setItem(storageKey(scope), JSON.stringify(['capsule:from-another-tab']))
      window.dispatchEvent(new StorageEvent('storage', { key: storageKey(scope) }))
    })
    expect(hook.result.current).toEqual(['capsule:from-another-tab'])
    expect(hiddenContent(scope)).toBe(hook.result.current)
  })

  it('ignores malformed persisted preferences and filters non-string values safely', () => {
    localStorage.setItem(storageKey(scope), '{invalid')
    expect(hiddenContent(scope)).toEqual([])
    localStorage.setItem(storageKey(scope), JSON.stringify({ hidden: true }))
    expect(hiddenContent(scope)).toEqual([])
    localStorage.setItem(storageKey(scope), JSON.stringify(['capsule:valid', null, 12, {}, false]))
    expect(hiddenContent(scope)).toEqual(['capsule:valid'])
    expect(hiddenContent(scope)).toBe(hiddenContent(scope))
  })

  it('keeps the last readable preferences when storage reads become unavailable', () => {
    setContentHidden(scope, 'capsule:retained', true)
    const previous = hiddenContent(scope)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    expect(hiddenContent(scope)).toBe(previous)
    expect(hiddenContent(`${scope}:unread`)).toEqual([])
  })

  it.each(['hide', 'restore'] as const)('does not announce a successful %s when persistence fails', action => {
    setContentHidden(scope, 'capsule:retained', true)
    const previous = hiddenContent(scope)
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    vi.spyOn(Storage.prototype, action === 'hide' ? 'setItem' : 'removeItem')
      .mockImplementation(() => { throw new Error('Device storage is full') })
    expect(() => action === 'hide'
      ? setContentHidden(scope, 'capsule:new', true)
      : restoreHiddenContent(scope)).toThrow('Device storage is full')
    expect(dispatch).not.toHaveBeenCalled()
    expect(hiddenContent(scope)).toBe(previous)
  })
})
