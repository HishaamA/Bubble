import { useEffect, useMemo, useState } from 'react'
import { subscribeToAppResume } from '../../lib/appResume'
import {
  fetchFamilyFlights,
  subscribeToFamilyFlights,
} from '../flights/flightStatusService'
import {
  FLIGHT_STORAGE_CHANGED_EVENT,
  flightStorageKey,
  mergeTrackedFlights,
  readTrackedFlights,
  type FlightStorageChangedDetail,
} from '../flights/flightStorage'
import type { TrackedFlight } from '../flights/types'
import { isNativeBubbleWidgetAvailable } from './nativeBubbleWidget'

const noFlights: readonly TrackedFlight[] = []

/** Keeps flight widget input fresh on every member tab, independently of photos. */
export function useWidgetFlights(storageSubject: string): readonly TrackedFlight[] {
  const native = isNativeBubbleWidgetAvailable()
  const cached = useMemo(() => native ? readTrackedFlights(storageSubject) : noFlights,
    [native, storageSubject])
  const [data, setData] = useState(() => ({ storageSubject, flights: cached }))

  useEffect(() => {
    if (!native) return
    let active = true
    let generation = 0
    let unsubscribe: () => void = () => undefined

    function readLocalChange() {
      if (!active) return
      // An earlier server response must not resurrect a flight just removed,
      // or replace a newly refreshed snapshot with the response's older data.
      generation += 1
      setData({ storageSubject, flights: readTrackedFlights(storageSubject) })
    }

    async function refresh() {
      if (!active) return
      const request = ++generation
      try {
        // Reads already-authorized family DB rows, never a paid flight provider.
        const shared = await fetchFamilyFlights()
        if (!active || request !== generation) return
        setData({
          storageSubject,
          flights: mergeTrackedFlights(readTrackedFlights(storageSubject), shared),
        })
        // The tracker owns persistence. Writing here would create event/fetch
        // loops and let a widget read mutate the user's flight collection.
      } catch {
        // Keep this account's cached/last authorized results available offline.
      }
    }

    function onLocalChange(event: Event) {
      const detail = (event as CustomEvent<FlightStorageChangedDetail>).detail
      if (detail?.subject === storageSubject) readLocalChange()
    }

    function onStorage(event: StorageEvent) {
      if (event.key === flightStorageKey(storageSubject) || event.key === null) readLocalChange()
    }

    // Catch a write between this scope's render and effect subscription.
    readLocalChange()
    window.addEventListener(FLIGHT_STORAGE_CHANGED_EVENT, onLocalChange)
    window.addEventListener('storage', onStorage)
    const stopResume = subscribeToAppResume(() => void refresh())
    void refresh()
    void subscribeToFamilyFlights(() => void refresh())
      .then((stop) => {
        if (active) unsubscribe = stop
        else stop()
      })
      .catch(() => undefined)

    return () => {
      active = false
      generation += 1
      unsubscribe()
      stopResume()
      window.removeEventListener(FLIGHT_STORAGE_CHANGED_EVENT, onLocalChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [native, storageSubject])

  // A new account's first render must never publish the previous one's flights.
  return !native ? noFlights : data.storageSubject === storageSubject ? data.flights : cached
}
