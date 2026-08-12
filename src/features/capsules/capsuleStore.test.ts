import { describe, expect, it } from 'vitest'
import { capsuleDatabaseNameForSubject } from './capsuleStore'

describe('Capsule storage namespace', () => {
  it('separates the same account cache across different families', () => {
    const firstFamily = capsuleDatabaseNameForSubject('user_simreen:family_a')
    const secondFamily = capsuleDatabaseNameForSubject('user_simreen:family_b')

    expect(firstFamily).not.toBe(secondFamily)
    expect(firstFamily).toContain('user_simreen%3Afamily_a')
    expect(secondFamily).toContain('user_simreen%3Afamily_b')
  })
})
