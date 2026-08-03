import { useEffect, useRef } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { useAuth } from '../auth'
import {
  resumeEventReminderAccount,
  transitionEventReminderAccount,
} from './eventReminders'

/** Owns notification lifecycle independently of the currently visible route. */
export function EventReminderCoordinator() {
  const { status, user } = useAuth()
  const activeAccount = status === 'signed-in' ? user?.id ?? null : null
  const activeAccountRef = useRef<string | null>(null)

  useEffect(() => {
    if (status === 'loading') return
    activeAccountRef.current = activeAccount
    void transitionEventReminderAccount(activeAccount)
  }, [activeAccount, status])

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
