import { useEffect, useRef } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { useAuth } from '../auth'
import { useFamilyOnboarding } from '../onboarding'
import {
  resumeEventReminderAccount,
  transitionEventReminderAccount,
} from './eventReminders'
import { familyEventStorageSubject } from './eventStorage'

/** Owns notification lifecycle independently of the currently visible route. */
export function EventReminderCoordinator() {
  const { status, user } = useAuth()
  const { snapshot, status: familyStatus } = useFamilyOnboarding()
  const familyId = snapshot?.kind === 'member'
    ? snapshot.membership.familyId
    : null
  const activeAccount = status === 'signed-in' && user?.id && familyId
    ? familyEventStorageSubject(user.id, familyId)
    : null
  const activeAccountRef = useRef<string | null>(null)

  useEffect(() => {
    if (
      status === 'loading'
      || familyStatus === 'idle'
      || familyStatus === 'loading'
    ) return
    activeAccountRef.current = activeAccount
    void transitionEventReminderAccount(activeAccount)
  }, [activeAccount, familyStatus, status])

  useEffect(() => {
    let disposed = false
    let removeListener: (() => Promise<void>) | undefined

    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        void resumeEventReminderAccount(activeAccountRef.current)
      }
    }).then((handle) => {
      if (disposed) void handle.remove()
      else removeListener = handle.remove
    })

    return () => {
      disposed = true
      if (removeListener) void removeListener()
    }
  }, [])

  return null
}
