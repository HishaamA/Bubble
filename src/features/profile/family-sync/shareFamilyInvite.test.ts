import { describe, expect, it, vi } from 'vitest'
import {
  getFamilyCodeMessage,
  getFamilyInviteMessage,
  shareFamilyCode,
  shareFamilyInvite,
} from './shareFamilyInvite'
import type { CreatedCircleInvite } from './types'

const invite: CreatedCircleInvite = {
  circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  code: `ks1_${'a'.repeat(64)}`,
  expiresAt: '2026-09-02T12:00:00.000Z',
  maxUses: 1,
}

describe('shareFamilyInvite', () => {
  it('shares the persistent family code with the same private wording', async () => {
    const share = vi.fn(async () => undefined)
    const code = 'BUB-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF'

    await expect(
      shareFamilyCode(code, 'Ahmed family', { share }),
    ).resolves.toBe('shared')
    expect(share).toHaveBeenCalledWith({
      title: 'Join Ahmed family',
      text: getFamilyCodeMessage(code, 'Ahmed family'),
    })
  })

  it('uses the native share sheet when the device supports it', async () => {
    const share = vi.fn(async () => undefined)

    await expect(
      shareFamilyInvite(invite, 'Ahmed family', { share }),
    ).resolves.toBe('shared')
    expect(share).toHaveBeenCalledWith({
      title: 'Join Ahmed family',
      text: getFamilyInviteMessage(invite, 'Ahmed family'),
    })
  })

  it('copies the private invitation when native sharing is unavailable', async () => {
    const writeText = vi.fn(async () => undefined)

    await expect(
      shareFamilyInvite(invite, 'Ahmed family', {
        clipboard: { writeText },
      }),
    ).resolves.toBe('copied')
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(invite.code),
    )
  })

  it('does not treat closing the native share sheet as an error', async () => {
    const share = vi.fn(async () => {
      throw new DOMException('Share cancelled', 'AbortError')
    })

    await expect(
      shareFamilyInvite(invite, 'Ahmed family', { share }),
    ).resolves.toBe('cancelled')
  })
})
