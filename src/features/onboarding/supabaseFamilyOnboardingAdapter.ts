import {
  getClerkSupabaseIdentity,
  getSupabaseClient,
} from '../../lib/supabase'
import {
  createFamily,
  joinFamilyByCode,
  readFamilyMembership,
} from '../../services/persistence'
import type {
  FamilyAccessActor,
  FamilyAccessSnapshot,
  FamilyOnboardingAdapter,
} from './types'

function requireMatchingActor(actor: FamilyAccessActor) {
  const identity = getClerkSupabaseIdentity()
  if (!identity || identity.subject !== actor.userId) {
    throw new Error('The family session no longer matches the signed-in user.')
  }
}

async function loadSnapshot(): Promise<FamilyAccessSnapshot> {
  const membership = await readFamilyMembership()
  if (membership.kind === 'member') {
    return {
      kind: 'member',
      membership: {
        familyId: membership.circleId,
        familyName: membership.circleName,
        role: membership.role,
        ownerId: membership.ownerId,
        memberCount: membership.memberCount,
        shareCode: membership.shareCode,
      },
    }
  }
  return membership.pendingRequestId
    ? { kind: 'pending', familyName: null }
    : { kind: 'needs-family' }
}

export const supabaseFamilyOnboardingAdapter: FamilyOnboardingAdapter = {
  configured: Boolean(getSupabaseClient()),

  async loadAccess(actor) {
    requireMatchingActor(actor)
    return loadSnapshot()
  },

  async createFamily(actor, familyName) {
    requireMatchingActor(actor)
    const family = await createFamily(familyName)
    return {
      kind: 'member',
      membership: {
        familyId: family.id,
        familyName: family.name,
        role: family.role,
        ownerId: family.ownerId,
        memberCount: family.memberCount,
        shareCode: family.shareCode,
      },
    }
  },

  async joinFamily(actor, inviteCode) {
    requireMatchingActor(actor)
    const family = await joinFamilyByCode(inviteCode)
    if ('requestId' in family) {
      return { kind: 'pending', familyName: null }
    }
    return {
      kind: 'member',
      membership: {
        familyId: family.id,
        familyName: family.name,
        role: family.role,
        ownerId: family.ownerId,
        memberCount: family.memberCount,
        shareCode: family.shareCode,
      },
    }
  },
}
