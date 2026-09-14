import { useEffect, type ReactNode } from 'react'
import { useAuth } from '../features/auth'
import {
  FamilyMomentSyncProvider,
  SharedMomentsProvider,
} from '../features/memories/shared'
import { useFamilyOnboarding } from '../features/onboarding'
import { createAccountCacheNamespace } from './accountCacheNamespace'
import { retainMemberSessionCaches } from './memberSessionCache'
import { retainNativeGalleryScope } from '../features/journal/people/nativeGalleryScan'

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
  const { snapshot, status: familyStatus } = useFamilyOnboarding()
  const familyId =
    snapshot?.kind === 'member' ? snapshot.membership.familyId : 'no-family'
  const cacheNamespace =
    status === 'signed-in' && user
      ? createAccountCacheNamespace(user.id, familyId)
      : 'signed-out:no-family'

  useEffect(() => retainMemberSessionCaches(cacheNamespace), [cacheNamespace])
  useEffect(() => {
    // Loading/error snapshots are not evidence that the member changed family.
    // Wait for a definitive auth/membership result before pruning a cold job.
    if (status === 'loading' || (status === 'signed-in' &&
      !['member', 'needs-family', 'pending'].includes(familyStatus))) return
    retainNativeGalleryScope(cacheNamespace)
  }, [cacheNamespace, familyStatus, status])

  return (
    <SharedMomentsProvider
      key={cacheNamespace}
      cacheNamespace={cacheNamespace}
    >
      <FamilyMomentSyncProvider>{children}</FamilyMomentSyncProvider>
    </SharedMomentsProvider>
  )
}
