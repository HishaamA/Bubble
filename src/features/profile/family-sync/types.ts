export type FamilySyncPerson = {
  id: string
  email: string
  displayName: string
}

export type FamilySyncPendingRequest = {
  id: string
  requesterId: string
  createdAt: string
}

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
      }
      pendingRequests: FamilySyncPendingRequest[]
    }

export type CreatedCircleInvite = {
  circleId: string
  code: string
  expiresAt: string
  maxUses: number
}

export type SignUpResult = {
  requiresEmailConfirmation: boolean
}

export type FamilySyncAdapter = {
  loadSnapshot: () => Promise<FamilySyncSnapshot>
  subscribeToAuthChanges?: (onChange: () => void) => () => void
  signIn: (email: string, password: string) => Promise<void>
  signUp: (
    email: string,
    password: string,
    displayName: string,
  ) => Promise<SignUpResult>
  signOut: () => Promise<void>
  createCircle: (name: string) => Promise<void>
  requestCircleJoin: (inviteCode: string) => Promise<void>
  createCircleInvite: (circleId: string) => Promise<CreatedCircleInvite>
  decideJoinRequest: (
    requestId: string,
    decision: 'approved' | 'rejected',
  ) => Promise<void>
}
