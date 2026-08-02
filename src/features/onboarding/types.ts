import type { AuthTokenGetter } from '../auth'

export type FamilyMembership = {
  familyId: string
  familyName: string
  role: 'owner' | 'member'
}

export type FamilyAccessSnapshot =
  | { kind: 'needs-family' }
  | { kind: 'pending'; familyName: string | null }
  | { kind: 'member'; membership: FamilyMembership }

export type FamilyAccessActor = {
  userId: string
  getToken: AuthTokenGetter
}

export type FamilyOnboardingAdapter = {
  configured: boolean
  readTutorial: (actor: FamilyAccessActor) => Promise<boolean>
  completeTutorial: (actor: FamilyAccessActor) => Promise<void>
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
