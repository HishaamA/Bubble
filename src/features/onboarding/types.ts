import type { AuthTokenGetter } from '../auth'

/** Family membership details required by route gates and settings. */
export type FamilyMembership = {
  familyId: string
  familyName: string
  role: 'owner' | 'member'
  ownerId?: string
  memberCount?: number
  shareCode?: string | null
}

/** Backend-independent result of resolving a person's family access. */
export type FamilyAccessSnapshot =
  | { kind: 'needs-family' }
  | { kind: 'pending'; familyName: string | null }
  | { kind: 'member'; membership: FamilyMembership }

/** Authenticated actor supplied to every onboarding persistence operation. */
export type FamilyAccessActor = {
  userId: string
  getToken: AuthTokenGetter
}

/** Persistence boundary for loading, creating, and joining a family. */
export type FamilyOnboardingAdapter = {
  configured: boolean
  loadAccess: (actor: FamilyAccessActor) => Promise<FamilyAccessSnapshot>
  createFamily: (
    actor: FamilyAccessActor,
    familyName: string,
  ) => Promise<FamilyAccessSnapshot>
  joinFamily: (
    actor: FamilyAccessActor,
    inviteCode: string,
  ) => Promise<FamilyAccessSnapshot>
}
