import { createContext, useContext } from 'react'
import type { FamilyAccessSnapshot } from './types'

/** Lifecycle states exposed by family onboarding. */
export type FamilyOnboardingStatus =
  | 'idle'
  | 'loading'
  | 'needs-family'
  | 'pending'
  | 'member'
  | 'unavailable'
  | 'error'

/** State and actions shared by onboarding gates and screens. */
export type FamilyOnboardingContextValue = {
  status: FamilyOnboardingStatus
  snapshot: FamilyAccessSnapshot | null
  error: string
  refreshing: boolean
  refresh: () => Promise<void>
  createFamily: (
    familyName: string,
  ) => Promise<FamilyAccessSnapshot | null>
  joinFamily: (inviteCode: string) => Promise<FamilyAccessSnapshot | null>
}

/** Nullable by design so a missing provider produces an immediate error. */
export const FamilyOnboardingContext =
  createContext<FamilyOnboardingContextValue | null>(null)

/** Returns family onboarding state from the nearest provider. */
export function useFamilyOnboarding() {
  const onboardingContext = useContext(FamilyOnboardingContext)
  if (!onboardingContext) {
    throw new Error(
      'useFamilyOnboarding must be used inside FamilyOnboardingProvider.',
    )
  }
  return onboardingContext
}
