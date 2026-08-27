import type { CreatedCircleInvite } from './types'

type ShareTarget = {
  share?: (data: ShareData) => Promise<void>
  clipboard?: {
    writeText: (text: string) => Promise<void>
  }
}

export type FamilyInviteShareResult = 'shared' | 'copied' | 'cancelled'

export type ShareFamilyCode = (
  code: string,
  circleName: string,
) => Promise<FamilyInviteShareResult>

export type ShareFamilyInvite = (
  invite: CreatedCircleInvite,
  circleName: string,
) => Promise<FamilyInviteShareResult>

export function getFamilyInviteMessage(
  invite: CreatedCircleInvite,
  circleName: string,
) {
  return `Join ${circleName} on Bubble with this private family code:\n${invite.code}`
}

export function getFamilyCodeMessage(code: string, circleName: string) {
  return `Join ${circleName} on Bubble with this private family code:\n${code}`
}

export async function shareFamilyCode(
  code: string,
  circleName: string,
  target: ShareTarget = navigator,
): Promise<FamilyInviteShareResult> {
  const text = getFamilyCodeMessage(code, circleName)

  if (target.share) {
    try {
      await target.share({
        title: `Join ${circleName}`,
        text,
      })
      return 'shared'
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        return 'cancelled'
      }
      throw reason
    }
  }

  if (target.clipboard) {
    await target.clipboard.writeText(text)
    return 'copied'
  }

  throw new Error('invite_sharing_unavailable')
}

export async function shareFamilyInvite(
  invite: CreatedCircleInvite,
  circleName: string,
  target: ShareTarget = navigator,
): Promise<FamilyInviteShareResult> {
  return shareFamilyCode(invite.code, circleName, target)
}
