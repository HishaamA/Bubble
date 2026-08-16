import { afterEach, describe, expect, it } from 'vitest'
import {
  clearDemoLoginSession,
  demoLoginAvailable,
  readDemoLoginSession,
  startDemoLoginSession,
} from './demoLogin'

afterEach(() => {
  window.localStorage.clear()
})

describe('demo login session', () => {
  it('is available for the prototype unless explicitly disabled at build time', () => {
    expect(demoLoginAvailable).toBe(true)
  })

  it('persists across app reloads until it is cleared', () => {
    expect(readDemoLoginSession()).toBe(false)
    expect(startDemoLoginSession()).toBe(true)
    expect(readDemoLoginSession()).toBe(true)

    clearDemoLoginSession()
    expect(readDemoLoginSession()).toBe(false)
  })
})
