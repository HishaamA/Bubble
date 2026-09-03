/** Maps family-service failures to safe, actionable onboarding copy. */
export function toFamilyOnboardingMessage(errorReason: unknown) {
  const errorRecord =
    errorReason && typeof errorReason === 'object'
      ? (errorReason as Record<string, unknown>)
      : null
  const rawMessage =
    errorReason instanceof Error
      ? errorReason.message
      : typeof errorRecord?.message === 'string'
        ? errorRecord.message
        : ''
  const errorCode =
    typeof errorRecord?.code === 'string'
      ? errorRecord.code.toLowerCase()
      : ''
  const normalizedMessage = rawMessage.toLowerCase()

  if (
    normalizedMessage.includes('invalid_invite_code') ||
    normalizedMessage.includes('invalid_family_code') ||
    normalizedMessage.includes('family_code_not_found')
  ) {
    return 'That family code is not valid.'
  }
  if (normalizedMessage.includes('invite_not_available')) {
    return 'That family code has expired, was revoked, or was already used.'
  }
  if (normalizedMessage.includes('already_a_member')) {
    return 'You are already connected to a family.'
  }
  if (normalizedMessage.includes('join_request_not_pending')) {
    return 'That request has already been handled. Check again for the latest status.'
  }
  if (
    normalizedMessage.includes('fetch') ||
    normalizedMessage.includes('network') ||
    normalizedMessage.includes('offline')
  ) {
    return 'Bubble could not reach your family space. Check your connection and try again.'
  }
  if (
    errorCode === '42501' ||
    normalizedMessage.includes('permission') ||
    normalizedMessage.includes('row-level security')
  ) {
    return 'Your family access may have changed. Sign in again or ask the family owner.'
  }
  if (
    normalizedMessage.includes('jwt') ||
    normalizedMessage.includes('session') ||
    normalizedMessage.includes('sign in')
  ) {
    return 'Your secure session needs to be renewed. Sign in again to continue.'
  }

  return 'Family setup could not be completed. Please try again.'
}
