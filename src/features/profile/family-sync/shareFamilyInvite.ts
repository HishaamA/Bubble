import type { CreatedCircleInvite } from './types'

type ShareTarget = {
  share?: (data: ShareData) => Promise<void>
  clipboard?: {
    writeText: (text: string) => Promise<void>
  }
}

/** Outcome used by the panel to distinguish success from user cancellation. */
export type FamilyInviteShareResult = 'shared' | 'copied' | 'cancelled'

/** Sharing boundary for the persistent family code. */
export type ShareFamilyCode = (
  code: string,
  circleName: string,
) => Promise<FamilyInviteShareResult>

/** Backward-compatible sharing boundary for legacy invite metadata. */
export type ShareFamilyInvite = (
  invite: CreatedCircleInvite,
  circleName: string,
) => Promise<FamilyInviteShareResult>

/** Builds share copy for legacy invite objects. */
export function getFamilyInviteMessage(
  invite: CreatedCircleInvite,
  circleName: string,
) {
  return getFamilyCodeMessage(invite.code, circleName)
}

/** Builds the private invitation text used by every sharing transport. */
export function getFamilyCodeMessage(code: string, circleName: string) {
  return `Join ${circleName} on Bubble with this private family code:\n${code}`
}

/** Shares through the native sheet when available and otherwise uses clipboard. */
export async function shareFamilyCode(
  code: string,
  circleName: string,
  shareTarget: ShareTarget = navigator,
): Promise<FamilyInviteShareResult> {
  const inviteMessage = getFamilyCodeMessage(code, circleName)

  if (shareTarget.share) {
    try {
      await shareTarget.share({
        title: `Join ${circleName}`,
        text: inviteMessage,
      })
      return 'shared'
    } catch (shareError) {
      if (
        shareError instanceof DOMException &&
        shareError.name === 'AbortError'
      ) {
        return 'cancelled'
      }
      throw shareError
    }
  }

  if (shareTarget.clipboard) {
    await shareTarget.clipboard.writeText(inviteMessage)
    return 'copied'
  }

  throw new Error('invite_sharing_unavailable')
}

/** Shares a legacy invite through the same persistent-code transport. */
export async function shareFamilyInvite(
  invite: CreatedCircleInvite,
  circleName: string,
  shareTarget: ShareTarget = navigator,
): Promise<FamilyInviteShareResult> {
  return shareFamilyCode(invite.code, circleName, shareTarget)
}
