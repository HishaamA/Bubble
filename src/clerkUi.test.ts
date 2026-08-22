import { describe, expect, it } from 'vitest'
import { clerkAppearance, clerkLocalization } from './clerkUi'

describe('Clerk modal presentation', () => {
  it('centers the modal and suppresses only the preview warning', () => {
    expect(clerkAppearance.options.unsafe_disableDevelopmentModeWarnings).toBe(
      true,
    )
    expect(clerkAppearance.elements.modalBackdrop.alignItems).toBe('center')
    expect(clerkAppearance.elements.modalContent.margin).toBe('auto')
    expect(clerkAppearance.elements.cardBox.overflowY).toBe('auto')
  })

  it('removes only the opening subtitles and keeps the phone copy compact', () => {
    expect(clerkLocalization.signIn.start).toMatchObject({
      subtitle: '',
      subtitleCombined: '',
    })
    expect(clerkLocalization.signUp.start).toMatchObject({
      subtitle: '',
      subtitleCombined: '',
    })
    expect(clerkLocalization.formFieldInputPlaceholder__phoneNumber).toBe(
      'Phone number',
    )
  })
})
