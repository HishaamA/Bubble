import { describe, expect, it } from 'vitest'
import { sameCapsulePhotoOwner } from './capsulePhotoOwnership'
import type { CapsulePhoto } from './types'

function photo(uploaderId: string | undefined, ownedByCurrentUser: boolean): CapsulePhoto {
  return { id: 'same-photo', capsuleId: 'capsule-a', image: 'fake-image', thumbnail: 'fake-thumbnail',
    width: 2, height: 1, caption: 'Test photo', contributorName: 'Test member',
    capturedAt: '2026-09-12T10:00:00Z', uploaderId, ownedByCurrentUser }
}

describe('sameCapsulePhotoOwner', () => {
  it.each([true, false])('rejects explicit different uploader IDs even when both owned flags are %s', owned => {
    expect(sameCapsulePhotoOwner(photo('uploader-a', owned), photo('uploader-b', owned))).toBe(false)
  })

  it('trusts an explicit matching uploader identity over older ownership flags', () => {
    expect(sameCapsulePhotoOwner(photo('uploader-a', true), photo('uploader-a', false))).toBe(true)
  })

  it.each([
    { localId: undefined, remoteId: 'uploader-a' },
    { localId: 'uploader-a', remoteId: undefined },
    { localId: undefined, remoteId: undefined },
  ])('uses the legacy fallback only for the current user’s own photo (%j)', ({ localId, remoteId }) => {
    expect(sameCapsulePhotoOwner(photo(localId, true), photo(remoteId, true))).toBe(true)
    expect(sameCapsulePhotoOwner(photo(localId, false), photo(remoteId, false))).toBe(false)
    expect(sameCapsulePhotoOwner(photo(localId, true), photo(remoteId, false))).toBe(false)
    expect(sameCapsulePhotoOwner(photo(localId, false), photo(remoteId, true))).toBe(false)
  })
})
