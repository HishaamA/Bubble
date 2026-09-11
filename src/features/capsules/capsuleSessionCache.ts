import { createMemberSessionCache } from '../../app/memberSessionCache'
import { startOfCapsuleWeek, toLocalDateInput } from './capsuleDates'
import { createDefaultCapsuleStore, createMemoryCapsuleStore } from './capsuleStore'
import type { CapsuleStore, FamilyCapsule } from './types'

export type CapsuleSyncResult = {
  capsules: FamilyCapsule[]
  authoritativeWeeklyId: string
}

/** Data survives tab unmounts; no hidden route, modal, or image DOM is retained. */
export type CapsuleSession = {
  store: CapsuleStore
  result?: CapsuleSyncResult
  refreshedAt: number
  observedAt: number
  weekKey: string
  inFlight: Promise<CapsuleSyncResult> | null
  disposed: boolean
}

const WARM_CAPSULE_TTL_MS = 30_000
const sessions = createMemberSessionCache<CapsuleSession>({
  dispose(session) {
    session.disposed = true
    session.result = undefined
    session.inFlight = null
  },
})

/** Custom test/embedded stores remain isolated from the production warm cache. */
export function getCapsuleSession(namespace: string, suppliedStore?: CapsuleStore): CapsuleSession {
  const existing = suppliedStore ? undefined : sessions.get(namespace)
  if (existing) return existing
  const session: CapsuleSession = {
    store: suppliedStore ?? (typeof window === 'undefined'
      ? createMemoryCapsuleStore()
      : createDefaultCapsuleStore(namespace)),
    refreshedAt: 0,
    observedAt: 0,
    weekKey: '',
    inFlight: null,
    disposed: false,
  }
  if (!suppliedStore) sessions.set(namespace, session)
  return session
}

/** A reveal or new week overrides the short rapid-tab reuse window. */
export function isCapsuleSessionFresh(session: CapsuleSession, now: Date) {
  if (session.disposed || !session.result || session.inFlight) return false
  const age = Date.now() - session.refreshedAt
  if (age < 0 || age >= WARM_CAPSULE_TTL_MS) return false
  if (session.weekKey !== toLocalDateInput(startOfCapsuleWeek(now))) return false
  return !session.result.capsules.some((capsule) => {
    const unlock = new Date(capsule.opensAt).getTime()
    return capsule.familySynced === true && unlock > session.observedAt && unlock <= now.getTime()
  })
}

/** Retains a durable local mutation while requiring its next server reconciliation. */
export function retainCapsuleSessionDraft(session: CapsuleSession, result: CapsuleSyncResult) {
  if (session.disposed) return
  session.result = result
  session.refreshedAt = 0
}

/** Shares a refresh across remounts without letting late work revive a cleared scope. */
export function refreshCapsuleSession(
  session: CapsuleSession,
  now: Date,
  work: () => Promise<CapsuleSyncResult>,
): Promise<CapsuleSyncResult> {
  if (session.disposed) return Promise.reject(new Error('This family session has ended.'))
  if (session.inFlight) return session.inFlight
  const request = work().then((result) => {
    if (!session.disposed) {
      session.result = result
      session.refreshedAt = Date.now()
      session.observedAt = now.getTime()
      session.weekKey = toLocalDateInput(startOfCapsuleWeek(now))
    }
    return result
  }).finally(() => {
    if (session.inFlight === request) session.inFlight = null
  })
  session.inFlight = request
  return request
}
