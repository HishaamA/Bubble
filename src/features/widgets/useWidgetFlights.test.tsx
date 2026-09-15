import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWidgetFlights } from './useWidgetFlights'
import {
  FLIGHT_STORAGE_CHANGED_EVENT,
  flightStorageKey,
  readTrackedFlights,
  writeTrackedFlights,
} from '../flights/flightStorage'
import type { TrackedFlight } from '../flights/types'

const mocks = vi.hoisted(() => ({
  native: true,
  fetch: vi.fn<() => Promise<TrackedFlight[]>>(),
  subscribe: vi.fn<(onChange: () => void) => Promise<() => void>>(),
  stop: vi.fn(),
  nativeRemove: vi.fn(async () => undefined),
  addListener: vi.fn(),
}))

vi.mock('./nativeBubbleWidget', () => ({ isNativeBubbleWidgetAvailable: () => mocks.native }))
vi.mock('../flights/flightStatusService', () => ({
  fetchFamilyFlights: mocks.fetch,
  subscribeToFamilyFlights: mocks.subscribe,
}))
vi.mock('@capacitor/app', () => ({ App: { addListener: mocks.addListener } }))

const alice = 'alice:family:a'
const bob = 'bob:family:b'
const flight: TrackedFlight = {
  id: 'flight-a', travelerName: 'Family member', flightNumber: 'EK202',
  travelDate: '2026-09-14', createdAt: '2026-09-10T12:00:00Z',
  notificationEnabled: true, synced: true,
  snapshot: {
    provider: 'aerodatabox', providerFlightId: 'EK202:2026-09-14', flightNumber: 'EK202',
    status: 'In flight', dataQuality: 'estimated',
    origin: { code: 'JFK', name: null, city: 'New York', latitude: 40.64, longitude: -73.77, timeZone: 'America/New_York' },
    destination: { code: 'DXB', name: null, city: 'Dubai', latitude: 25.25, longitude: 55.36, timeZone: 'Asia/Dubai' },
    scheduledDeparture: '2026-09-14T10:00:00Z', estimatedDeparture: null, actualDeparture: null,
    scheduledArrival: '2026-09-14T20:00:00Z', estimatedArrival: null, actualArrival: null,
    progressPercent: 50, position: null, updatedAt: '2026-09-14T15:00:00Z',
  },
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => { resolve = done })
  return { promise, resolve }
}

function seed(subject: string, flights: TrackedFlight[]) {
  localStorage.setItem(flightStorageKey(subject), JSON.stringify(flights))
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mocks.native = true
  mocks.fetch.mockReset().mockImplementation(() => new Promise(() => undefined))
  mocks.subscribe.mockReset().mockResolvedValue(mocks.stop)
  mocks.addListener.mockResolvedValue({ remove: mocks.nativeRemove })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('useWidgetFlights', () => {
  it('does not read/publish flights or start subscriptions in the browser', () => {
    mocks.native = false
    seed(alice, [flight])
    const { result } = renderHook(() => useWidgetFlights(alice))
    expect(result.current).toEqual([])
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.addListener).not.toHaveBeenCalled()
  })

  it('starts from the exact member cache and keeps it while offline', async () => {
    seed(alice, [flight])
    seed(bob, [{ ...flight, id: 'private-to-bob' }])
    mocks.fetch.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useWidgetFlights(alice))
    expect(result.current).toEqual([flight])
    await act(async () => undefined)
    expect(result.current).toEqual([flight])
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('reacts to local creation, refresh and deletion without mounting the flight tab', async () => {
    const { result } = renderHook(() => useWidgetFlights(alice))
    await act(async () => { writeTrackedFlights(alice, [flight]) })
    expect(result.current).toEqual([flight])
    const refreshed = { ...flight, snapshot: { ...flight.snapshot, progressPercent: 70 } }
    await act(async () => { writeTrackedFlights(alice, [refreshed]) })
    expect(result.current[0].snapshot.progressPercent).toBe(70)
    await act(async () => { writeTrackedFlights(alice, []) })
    expect(result.current).toEqual([])
    // Local cache notifications never introduce paid provider refreshes or DB loops.
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not resurrect a removed flight when an older family read finishes', async () => {
    seed(alice, [flight])
    const pending = deferred<TrackedFlight[]>()
    mocks.fetch.mockReturnValue(pending.promise)
    const { result } = renderHook(() => useWidgetFlights(alice))
    await act(async () => { writeTrackedFlights(alice, []) })
    await act(async () => { pending.resolve([flight]) })
    expect(result.current).toEqual([])
    expect(readTrackedFlights(alice)).toEqual([])
  })

  it('ignores foreign-scope events without invalidating its own pending response', async () => {
    const pending = deferred<TrackedFlight[]>()
    mocks.fetch.mockReturnValue(pending.promise)
    const { result } = renderHook(() => useWidgetFlights(alice))
    await act(async () => {
      writeTrackedFlights(bob, [{ ...flight, id: 'bob-flight' }])
      window.dispatchEvent(new StorageEvent('storage', { key: flightStorageKey(bob) }))
      window.dispatchEvent(new Event(FLIGHT_STORAGE_CHANGED_EVENT))
    })
    expect(result.current).toEqual([])
    await act(async () => { pending.resolve([flight]) })
    expect(result.current.map((item) => item.id)).toEqual(['flight-a'])
  })

  it('changes scopes without even a first-render flash and rejects a previous account response', async () => {
    const oldResponse = deferred<TrackedFlight[]>()
    const newResponse = deferred<TrackedFlight[]>()
    mocks.fetch.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise)
    seed(alice, [flight])
    seed(bob, [{ ...flight, id: 'bob-flight' }])
    const renders: string[][] = []
    const view = renderHook(({ subject }) => {
      const flights = useWidgetFlights(subject)
      renders.push(flights.map((item) => item.id))
      return flights
    }, { initialProps: { subject: alice } })
    const boundary = renders.length
    view.rerender({ subject: bob })
    expect(renders.slice(boundary).every((ids) => !ids.includes('flight-a'))).toBe(true)
    await act(async () => { oldResponse.resolve([{ ...flight, id: 'late-alice' }]) })
    expect(view.result.current.map((item) => item.id)).toEqual(['bob-flight'])
    await act(async () => { newResponse.resolve([{ ...flight, id: 'new-bob' }]) })
    expect(view.result.current.map((item) => item.id)).toEqual(['new-bob'])
    expect(mocks.stop).toHaveBeenCalledTimes(1)
  })

  it('merges remote changes with local drafts and alert preferences without rewriting storage', async () => {
    const draft = { ...flight, id: 'local-draft', synced: false }
    seed(alice, [flight, draft])
    mocks.fetch.mockResolvedValue([{ ...flight, notificationEnabled: false,
      snapshot: { ...flight.snapshot, status: 'Delayed' } }])
    const listener = vi.fn()
    window.addEventListener(FLIGHT_STORAGE_CHANGED_EVENT, listener)
    try {
      const { result } = renderHook(() => useWidgetFlights(alice))
      await waitFor(() => expect(result.current.find((item) => item.id === flight.id)?.snapshot.status).toBe('Delayed'))
      expect(result.current.find((item) => item.id === flight.id)?.notificationEnabled).toBe(true)
      expect(result.current.some((item) => item.id === draft.id)).toBe(true)
      expect(readTrackedFlights(alice)).toEqual([flight, draft])
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(FLIGHT_STORAGE_CHANGED_EVENT, listener)
    }
  })

  it('takes only the latest remote refresh and resumes after returning online/visible', async () => {
    const first = deferred<TrackedFlight[]>()
    const second = deferred<TrackedFlight[]>()
    mocks.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useWidgetFlights(alice))
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await act(async () => { second.resolve([{ ...flight, id: 'latest' }]) })
    await act(async () => { first.resolve([{ ...flight, id: 'stale' }]) })
    expect(result.current.map((item) => item.id)).toEqual(['latest'])
    mocks.fetch.mockResolvedValue([])
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(result.current).toEqual([])
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })

  it('rereads matching browser-storage changes and cleans up listeners/late subscriptions', async () => {
    const lateSubscription = deferred<() => void>()
    mocks.subscribe.mockReturnValue(lateSubscription.promise)
    const view = renderHook(() => useWidgetFlights(alice))
    seed(alice, [flight])
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: flightStorageKey(alice) })) })
    expect(view.result.current).toEqual([flight])
    view.unmount()
    await act(async () => {
      lateSubscription.resolve(mocks.stop)
      mocks.subscribe.mock.calls[0][0]()
      window.dispatchEvent(new Event('online'))
      document.dispatchEvent(new Event('visibilitychange'))
      writeTrackedFlights(alice, [])
    })
    expect(mocks.stop).toHaveBeenCalledTimes(1)
    expect(mocks.nativeRemove).toHaveBeenCalledTimes(1)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })
})
