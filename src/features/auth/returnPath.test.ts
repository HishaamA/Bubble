import { describe, expect, it } from 'vitest'
import { getSafeReturnPath } from './returnPath'

const blockedRoutes = ['/login', '/onboarding'] as const

describe('getSafeReturnPath', () => {
  it('preserves complete internal routes outside the blocked gates', () => {
    expect(
      getSafeReturnPath('/journal?view=family#memory-4', blockedRoutes),
    ).toBe('/journal?view=family#memory-4')
  })

  it.each([
    'https://attacker.example/path',
    '//attacker.example/path',
    '/\\attacker.example/path',
    '/login',
    '/login/reset',
    '/onboarding/family',
  ])('rejects unsafe or recursive destination %s', (candidate) => {
    expect(getSafeReturnPath(candidate, blockedRoutes)).toBe('/')
  })
})
