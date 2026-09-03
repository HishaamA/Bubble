/** A signed-in person whose profile can participate in family sync. */
export type FamilySyncPerson = {
  id: string
  email: string
  displayName: string
}

/** A join request visible to the owner of a connected family. */
export type FamilySyncPendingRequest = {
  id: string
  requesterId: string
  createdAt: string
}

/** Every backend state the family-sync panel can render. */
export type FamilySyncSnapshot =
  | { kind: 'local-only' }
  | { kind: 'signed-out' }
  | {
      kind: 'unjoined'
      person: FamilySyncPerson
      pendingRequest: {
        id: string
        createdAt: string
      } | null
    }
  | {
      kind: 'connected'
      person: FamilySyncPerson
      circle: {
        id: string
        name: string
        role: 'owner' | 'member'
        memberCount: number
        shareCode: string
      }
      pendingRequests: FamilySyncPendingRequest[]
    }

/** Legacy one-use invite metadata retained for backward-compatible sharing. */
export type CreatedCircleInvite = {
  circleId: string
  code: string
  expiresAt: string
  maxUses: number
}

/** Persistence operations required by the family-sync panel. */
export type FamilySyncAdapter = {
  loadSnapshot: () => Promise<FamilySyncSnapshot>
  subscribeToAuthChanges?: (onChange: () => void) => () => void
  createCircle: (name: string) => Promise<void>
  requestCircleJoin: (inviteCode: string) => Promise<void>
  rotateFamilyCode: (circleId: string) => Promise<string>
  decideJoinRequest: (
    requestId: string,
    decision: 'approved' | 'rejected',
  ) => Promise<void>
}
