import { createContext, useContext } from 'react'
import type { Capture360Submission } from '../../capture'
import type { FamilyDailyCaptureWindow } from '../../../services/media/familyMomentService'

export type FamilySyncStatus = 'checking' | 'local' | 'connected' | 'error'

export type FamilyMomentSyncContextValue = {
  status: FamilySyncStatus
  dailyWindow: FamilyDailyCaptureWindow | null
  error: Error | null
  shareMoment(
    submission: Capture360Submission,
  ): Promise<{ delivery: 'local' | 'family' }>
  refreshFamilyMoments(): Promise<void>
}

export const FamilyMomentSyncContext =
  createContext<FamilyMomentSyncContextValue | null>(null)

export function useFamilyMomentSync() {
  const context = useContext(FamilyMomentSyncContext)
  if (!context) {
    throw new Error(
      'useFamilyMomentSync must be used within FamilyMomentSyncProvider',
    )
  }
  return context
}
