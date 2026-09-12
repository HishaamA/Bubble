import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createMemberSessionCache } from '../../../app/memberSessionCache'
import {
  emptyPeopleTimelineState,
  loadPeopleTimelineState,
  savePeopleTimelineState,
} from './peopleTimelineStore'
import type { PeopleTimelineState } from './types'

/** Private, device-only metadata survives tab remounts, never member changes. */
function createPeopleTimelineSession(namespace: string) {
  let active = true
  let snapshot = { state: emptyPeopleTimelineState(), ready: false }
  let hydration: Promise<void> | undefined
  let saveQueue = Promise.resolve()
  let lastScheduledState: PeopleTimelineState | undefined
  let lastSaveResult = Promise.resolve(true)
  const listeners = new Set<() => void>()
  const publish = (state: PeopleTimelineState, ready: boolean) => {
    snapshot = { state, ready }
    listeners.forEach((notify) => notify())
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (notify: () => void) => {
      listeners.add(notify)
      return () => { listeners.delete(notify) }
    },
    hydrate() {
      if (!active || hydration || snapshot.ready) return hydration
      const initialState = snapshot.state
      hydration = loadPeopleTimelineState(namespace)
        .catch(() => emptyPeopleTimelineState())
        .then((state) => {
          // A departed account or a newer in-memory edit owns the boundary.
          if (!active || snapshot.state !== initialState) return
          lastScheduledState = state
          publish(state, true)
        })
      return hydration
    },
    replace(state: PeopleTimelineState) {
      if (!active) return false
      if (snapshot.state !== state) publish(state, true)
      return true
    },
    save(state: PeopleTimelineState) {
      if (!active) return Promise.resolve(false)
      // Hydration is not an edit. Coalesce a scan checkpoint with the ordinary
      // autosave, and keep one ordered write queue across rapid tab remounts.
      if (state === lastScheduledState) return lastSaveResult
      lastScheduledState = state
      const result = saveQueue
        .then(() => active ? savePeopleTimelineState(namespace, state) : false)
        .catch(() => false)
        .then((saved) => {
          if (!saved && lastScheduledState === state) lastScheduledState = undefined
          return saved
        })
      saveQueue = result.then(() => undefined)
      lastSaveResult = result
      return result
    },
    dispose() {
      active = false
      lastScheduledState = undefined
      publish(emptyPeopleTimelineState(), false)
      listeners.clear()
    },
  }
}

const sessions = createMemberSessionCache<ReturnType<typeof createPeopleTimelineSession>>({
  dispose: (session) => session.dispose(),
})

function getPeopleTimelineSession(namespace: string) {
  let session = sessions.get(namespace)
  if (!session) {
    session = createPeopleTimelineSession(namespace)
    sessions.set(namespace, session)
  }
  return session
}

/** Quietly prepares device-only metadata; no photos, network, or face model work. */
export function preloadPeopleTimelineSession(namespace: string) {
  return getPeopleTimelineSession(namespace).hydrate()
}

/** Synchronous warm state avoids empty People/album rails on each Journal visit. */
export function usePeopleTimelineSession(namespace: string) {
  const session = useMemo(() => getPeopleTimelineSession(namespace), [namespace])
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  useEffect(() => { void session.hydrate() }, [session])
  return { ...snapshot, replace: session.replace, save: session.save }
}
