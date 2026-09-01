import { flightDepartureTime, isFlightComplete } from './flightValidation'
import type { TrackedFlight } from './types'

const policyStoragePrefix = 'kinsphere-family-flights:auto-refresh:v2:'
const policyMemoryStorage = new Map<string, AutomaticRefreshState>()

export const automaticRefreshWindowMs = 6 * 60 * 60 * 1000
export const automaticRefreshLimit = 2
export const nearFlightRefreshAgeMs = 60 * 60 * 1000
export const farFlightRefreshAgeMs = 24 * 60 * 60 * 1000

type AutomaticRefreshState = {
  attempts: Record<string, number>
  budget: number[]
}

function policyStorageKey(subject: string) {
  return `${policyStoragePrefix}${encodeURIComponent(subject)}`
}

function safeTimestamp(value: unknown, now: number) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= now + 60_000
}

function readPolicy(subject: string, now: number): AutomaticRefreshState {
  const key = policyStorageKey(subject)
  let parsed: unknown
  try {
    const stored = localStorage.getItem(key)
    parsed = stored ? JSON.parse(stored) : policyMemoryStorage.get(key)
  } catch {
    parsed = policyMemoryStorage.get(key)
  }
  if (!parsed || typeof parsed !== 'object') return { attempts: {}, budget: [] }
  const candidate = parsed as Partial<AutomaticRefreshState>
  const attempts = Object.fromEntries(
    Object.entries(candidate.attempts ?? {}).filter(([, value]) =>
      safeTimestamp(value, now)
      && now - value < farFlightRefreshAgeMs,
    ),
  )
  const budget = Array.isArray(candidate.budget)
    ? candidate.budget.filter((value) =>
        safeTimestamp(value, now)
        && now - value < automaticRefreshWindowMs,
      )
    : []
  return { attempts, budget }
}

function writePolicy(subject: string, state: AutomaticRefreshState) {
  const key = policyStorageKey(subject)
  try {
    localStorage.setItem(key, JSON.stringify(state))
    policyMemoryStorage.delete(key)
  } catch {
    policyMemoryStorage.set(key, state)
  }
}

function refreshAge(flight: TrackedFlight, nowMs: number) {
  const departure = flightDepartureTime(flight.snapshot)
  const departureMs = departure ? new Date(departure).getTime() : Number.NaN
  const near = Number.isFinite(departureMs)
    && departureMs >= nowMs - 18 * 60 * 60 * 1000
    && departureMs <= nowMs + 48 * 60 * 60 * 1000
  return near ? nearFlightRefreshAgeMs : farFlightRefreshAgeMs
}

/**
 * Records and returns a small automatic batch. The persisted rolling budget is
 * per account/family on this device, so reopening the app cannot burn the free
 * provider allowance repeatedly. Attempts are reserved before callers launch
 * network work: concurrent effects/remounts therefore share the same budget,
 * and failures intentionally consume a slot rather than creating a retry loop.
 */
export function takeAutomaticRefreshCandidates(
  flights: TrackedFlight[],
  subject: string,
  now = new Date(),
) {
  const nowMs = now.getTime()
  const state = readPolicy(subject, nowMs)
  const available = Math.max(0, automaticRefreshLimit - state.budget.length)
  if (available === 0) {
    writePolicy(subject, state)
    return []
  }

  const candidates = flights.filter((flight) => {
    if (!flight.synced || isFlightComplete(flight.snapshot)) return false
    const minimumAge = refreshAge(flight, nowMs)
    const updatedAt = new Date(flight.snapshot.updatedAt).getTime()
    const attemptedAt = state.attempts[flight.id] ?? 0
    return Number.isFinite(updatedAt)
      && nowMs - updatedAt >= minimumAge
      && nowMs - attemptedAt >= minimumAge
  }).sort((left, right) => {
    const leftDeparture = flightDepartureTime(left.snapshot)
    const rightDeparture = flightDepartureTime(right.snapshot)
    const leftNear = refreshAge(left, nowMs) === nearFlightRefreshAgeMs
    const rightNear = refreshAge(right, nowMs) === nearFlightRefreshAgeMs
    if (leftNear !== rightNear) return leftNear ? -1 : 1
    const leftAttempt = state.attempts[left.id] ?? 0
    const rightAttempt = state.attempts[right.id] ?? 0
    if (leftAttempt !== rightAttempt) return leftAttempt - rightAttempt
    return (leftDeparture ? new Date(leftDeparture).getTime() : Number.MAX_VALUE)
      - (rightDeparture ? new Date(rightDeparture).getTime() : Number.MAX_VALUE)
  }).slice(0, available)

  if (candidates.length > 0) {
    // Write reservations as one batch before returning any candidates. A crash
    // after this point may defer an update, but it cannot cause an uncontrolled
    // provider burst on the next launch.
    for (const candidate of candidates) state.attempts[candidate.id] = nowMs
    state.budget.push(...candidates.map(() => nowMs))
  }
  writePolicy(subject, state)
  return candidates
}

export function clearAutomaticRefreshPolicy(subject: string) {
  const key = policyStorageKey(subject)
  policyMemoryStorage.delete(key)
  try {
    localStorage.removeItem(key)
  } catch {
    // The in-memory policy was still cleared.
  }
}
