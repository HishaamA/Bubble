import type { CreatedCircleInvite } from './types'

type ShareTarget = {
  share?: (data: ShareData) => Promise<void>
  clipboard?: {
    writeText: (text: string) => Promise<void>
  }
}

export type FamilyInviteShareResult = 'shared' | 'copied' | 'cancelled'

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

export async function shareFamilyInvite(
  invite: CreatedCircleInvite,
  circleName: string,
  target: ShareTarget = navigator,
): Promise<FamilyInviteShareResult> {
  const text = getFamilyInviteMessage(invite, circleName)

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
