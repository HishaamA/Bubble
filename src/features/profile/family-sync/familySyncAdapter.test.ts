import { describe, expect, it } from 'vitest'
import { toFamilySyncErrorMessage } from './familySyncAdapter'

describe('toFamilySyncErrorMessage', () => {
  it('turns invite failures into useful messages without echoing credentials', () => {
    expect(toFamilySyncErrorMessage(new Error('invalid_invite_code'))).toBe(
      'That family code is not valid.',
    )
    expect(toFamilySyncErrorMessage(new Error('invite_not_available'))).toBe(
      'That invite has expired, was revoked, or has already been used.',
    )
  })

  it('explains invalid persistent family codes without exposing them', () => {
    expect(toFamilySyncErrorMessage(new Error('family_code_not_found'))).toBe(
      'That family code is not valid.',
    )
    expect(toFamilySyncErrorMessage(new Error('invalid_family_code'))).toBe(
      'That family code is not valid.',
    )
  })

  it('explains owner-only membership decisions', () => {
    expect(toFamilySyncErrorMessage(new Error('circle_owner_required'))).toBe(
      'Only the family circle owner can do that.',
    )
  })

  it('does not expose unknown backend details in the settings page', () => {
    const backendMessage =
      'SQL failed for service_role credential abc123 in private_table'

    expect(toFamilySyncErrorMessage(new Error(backendMessage))).toBe(
      'Family Sync could not complete that request.',
    )
    expect(toFamilySyncErrorMessage(new Error(backendMessage))).not.toContain(
      'abc123',
    )
  })
})
