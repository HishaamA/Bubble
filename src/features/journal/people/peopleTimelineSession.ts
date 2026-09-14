import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createMemberSessionCache } from '../../../app/memberSessionCache'
import {
  emptyPeopleTimelineState,
  loadPeopleTimelineState,
  savePeopleTimelineState,
} from './peopleTimelineStore'
import type { PeopleTimelineState, StoredPhotoFaceScan } from './types'
import { prunePhoneGalleryMatches } from '../phoneGalleryPhotos'

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
  const save = (state: PeopleTimelineState, canWrite: () => boolean = () => true) => {
    if (!active || !canWrite()) return Promise.resolve(false)
    // A delayed React effect cannot enqueue an older full snapshot after a
    // newer scanner batch or edit. The live snapshot owns persistence.
    if (state !== snapshot.state) return Promise.resolve(true)
    if (state === lastScheduledState) return lastSaveResult
    lastScheduledState = state
    const result = saveQueue
      // Another editor may change the snapshot while this write is queued.
      // Persist the current authoritative state, never resurrect rolled-back
      // batch keys captured by an earlier autosave request.
      .then(() => active && canWrite() ? savePeopleTimelineState(namespace, snapshot.state) : false)
      .catch(() => false)
      .then((saved) => {
        if (!saved && lastScheduledState === state) lastScheduledState = undefined
        return saved
      })
    saveQueue = result.then(() => undefined)
    lastSaveResult = result
    return result
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
    save,
    /** Merge one checkpoint batch into the latest edits, never a captured React snapshot. */
    async mergeScans(scans: Record<string, StoredPhotoFaceScan>, canWrite: () => boolean = () => true) {
      if (!active || !snapshot.ready || !canWrite()) return { saved: false, mergedKeys: [] as string[] }
      const entries = Object.entries(scans).filter(([key]) => !Object.hasOwn(snapshot.state.faceScans, key))
      if (entries.length === 0) return { saved: true, mergedKeys: [] as string[] }
      const next = { ...snapshot.state, faceScans: { ...snapshot.state.faceScans, ...Object.fromEntries(entries) } }
      publish(next, true)
      const saved = await save(next, canWrite)
      if (!saved && active) {
        const faceScans = { ...snapshot.state.faceScans }
        let changed = false
        for (const [key, scan] of entries) {
          // Roll back only this batch's exact values, never a later scan or
          // independent edits to people, assignments or corrected dates.
          if (faceScans[key] === scan) { delete faceScans[key]; changed = true }
        }
        if (changed) publish({ ...snapshot.state, faceScans }, true)
      }
      return { saved, mergedKeys: saved ? entries.map(([key]) => key) : [] }
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

export function getPeopleTimelineSession(namespace: string) {
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

/** Removes departed device-photo matches through the same ordered save queue as scans. */
export async function reconcilePhoneGalleryTimeline(namespace: string, allowedKeys: ReadonlySet<string>) {
  const session = getPeopleTimelineSession(namespace)
  await session.hydrate()
  const current = session.getSnapshot().state
  const next = prunePhoneGalleryMatches(current, allowedKeys)
  if (next === current || !session.replace(next)) return true
  return session.save(next)
}

/** Synchronous warm state avoids empty People/album rails on each Journal visit. */
export function usePeopleTimelineSession(namespace: string) {
  const session = useMemo(() => getPeopleTimelineSession(namespace), [namespace])
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  useEffect(() => { void session.hydrate() }, [session])
  return { ...snapshot, replace: session.replace, save: session.save, getSnapshot: session.getSnapshot }
}
