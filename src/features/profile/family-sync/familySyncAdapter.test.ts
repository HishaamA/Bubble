import { describe, expect, it } from 'vitest'
import { toFamilySyncErrorMessage } from './familySyncAdapter'

describe('toFamilySyncErrorMessage', () => {
  it('turns invite failures into useful messages without echoing credentials', () => {
    expect(toFamilySyncErrorMessage(new Error('invalid_invite_code'))).toBe(
      'That invite code is not valid.',
    )
    expect(toFamilySyncErrorMessage(new Error('invite_not_available'))).toBe(
      'That invite has expired, was revoked, or has already been used.',
    )
  })

  it('explains owner-only membership decisions', () => {
    expect(toFamilySyncErrorMessage(new Error('circle_owner_required'))).toBe(
      'Only the family circle owner can do that.',
    )
  })
})
