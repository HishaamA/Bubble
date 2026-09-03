import type { ReactNode } from 'react'
import { useAuth } from '../features/auth'
import {
  FamilyMomentSyncProvider,
  SharedMomentsProvider,
} from '../features/memories/shared'
import { useFamilyOnboarding } from '../features/onboarding'
import { createAccountCacheNamespace } from './accountCacheNamespace'

type AccountScopedDataProps = {
  children: ReactNode
}

/**
 * Owns local caches and family synchronization for the active membership.
 * The provider key intentionally tears down object URLs, subscriptions, and
 * IndexedDB state whenever the active account or family changes.
 */
export function AccountScopedData({ children }: AccountScopedDataProps) {
  const { status, user } = useAuth()
  const { snapshot } = useFamilyOnboarding()
  const familyId =
    snapshot?.kind === 'member' ? snapshot.membership.familyId : 'no-family'
  const cacheNamespace =
    status === 'signed-in' && user
      ? createAccountCacheNamespace(user.id, familyId)
      : 'signed-out:no-family'

  return (
    <SharedMomentsProvider
      key={cacheNamespace}
      cacheNamespace={cacheNamespace}
    >
      <FamilyMomentSyncProvider>{children}</FamilyMomentSyncProvider>
    </SharedMomentsProvider>
  )
}
