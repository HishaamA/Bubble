import {
  getClerkSupabaseIdentity,
  getSupabaseClient,
} from '../../lib/supabase'
import {
  createFamily,
  joinFamilyByCode,
  markTutorialComplete,
  readFamilyMembership,
  readOnboardingState,
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
      },
    }
  }
  return membership.pendingRequestId
    ? { kind: 'pending', familyName: null }
    : { kind: 'needs-family' }
}

export const supabaseFamilyOnboardingAdapter: FamilyOnboardingAdapter = {
  configured: Boolean(getSupabaseClient()),

  async readTutorial(actor) {
    requireMatchingActor(actor)
    return (await readOnboardingState()).completed
  },

  async completeTutorial(actor) {
    requireMatchingActor(actor)
    await markTutorialComplete()
  },

  async loadAccess(actor) {
    requireMatchingActor(actor)
    return loadSnapshot()
  },

  async createFamily(actor, familyName) {
    requireMatchingActor(actor)
    await createFamily(familyName)
    return loadSnapshot()
  },

  async joinFamily(actor, inviteCode) {
    requireMatchingActor(actor)
    await joinFamilyByCode(inviteCode)
    return loadSnapshot()
  },
}
