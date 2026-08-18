import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { App as CapacitorApp } from '@capacitor/app'
import { useAuth } from '../auth'
import { useFamilyOnboarding } from '../onboarding'
import {
  cancelFlightNotifications,
  enableFlightNotifications,
  rescheduleFlightNotifications,
} from './flightNotifications'
import {
  createTrackedFamilyFlight,
  createTrackedFlightId,
  fetchFamilyFlights,
  FlightStatusError,
  refreshTrackedFamilyFlight,
  removeFamilyFlight,
  subscribeToFamilyFlights,
} from './flightStatusService'
import {
  clearPendingFlightCreateIntent,
  familyFlightStorageSubject,
  getOrCreatePendingFlightCreateId,
  mergeTrackedFlights,
  readActiveFlightStorageSubject,
  readTrackedFlights,
  writeActiveFlightStorageSubject,
  writeTrackedFlights,
} from './flightStorage'
import { takeAutomaticRefreshCandidates } from './flightAutomaticRefresh'
import {
  calculateFlightProgress,
  effectiveFlightDataQuality,
  flightArrivalTime,
  flightDepartureTime,
  formatFlightDateTime,
  isFlightCancelled,
  localCalendarDate,
  shiftLocalCalendarDate,
  validateFlightForm,
  type FlightFormValidation,
} from './flightValidation'
import type {
  FlightCoordinates,
  FlightStatusSnapshot,
  TrackedFlight,
} from './types'
import './FlightTrackerSection.css'

export type FlightTrackerSectionProps = {
  now?: Date
}

type FieldError = Extract<FlightFormValidation, { valid: false }>
type FormError = { field: FieldError['field'] | null; message: string }

function qualityLabel(quality: FlightStatusSnapshot['dataQuality']) {
  if (quality === 'live') return 'Live'
  if (quality === 'estimated') return 'Estimated'
  return 'Scheduled'
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${value}T12:00:00`))
}

function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function airportPlace(snapshot: FlightStatusSnapshot, side: 'origin' | 'destination') {
  const airport = snapshot[side]
  return airport.city ?? airport.name ?? airport.code
}

function PlaneIcon({ title }: { title?: string }) {
  return (
    <svg
      className="flight-plane-icon"
      viewBox="0 0 24 24"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d="M21.4 13.2 14 10.4V4.7c0-1.1-.9-2.7-2-2.7s-2 1.6-2 2.7v5.7l-7.4 2.8c-.4.2-.7.6-.6 1.1l.2 1.1c.1.4.5.7.9.6l6.9-1.1v4l-2.1 1.5c-.3.2-.4.5-.3.8l.2.7c.1.3.4.5.8.4l3.4-.8 3.4.8c.4.1.7-.1.8-.4l.2-.7c.1-.3 0-.6-.3-.8L14 18.9v-4l6.9 1.1c.4.1.8-.2.9-.6l.2-1.1c.1-.5-.2-.9-.6-1.1Z" />
    </svg>
  )
}

function FlightProgress({ flight, now }: { flight: TrackedFlight; now: Date }) {
  if (isFlightCancelled(flight.snapshot)) {
    return (
      <div className="flight-progress flight-progress--cancelled" role="status">
        Journey cancelled · no progress shown
      </div>
    )
  }
  const progress = calculateFlightProgress(flight.snapshot, now)
  const style = { '--flight-progress': progress } as CSSProperties
  return (
    <div
      className="flight-progress"
      role="progressbar"
      aria-label={`${flight.flightNumber} journey progress`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      style={style}
    >
      <span className="flight-progress__fill" aria-hidden="true" />
      <span className="flight-progress__plane" aria-hidden="true">
        <PlaneIcon />
      </span>
    </div>
  )
}

function project({ latitude, longitude }: FlightCoordinates) {
  return {
    x: (longitude + 180) / 360 * 360,
    y: (90 - latitude) / 180 * 172 + 4,
  }
}

function pointOnQuadratic(
  start: { x: number; y: number },
  control: { x: number; y: number },
  end: { x: number; y: number },
  progress: number,
) {
  const inverse = 1 - progress
  return {
    x: inverse * inverse * start.x
      + 2 * inverse * progress * control.x
      + progress * progress * end.x,
    y: inverse * inverse * start.y
      + 2 * inverse * progress * control.y
      + progress * progress * end.y,
  }
}

function FlightRouteMap({ flight, now }: { flight: TrackedFlight; now: Date }) {
  const { snapshot } = flight
  if (isFlightCancelled(snapshot)) {
    return (
      <div className="flight-map flight-map--cancelled" role="status">
        <strong>Flight cancelled</strong>
        <span>No aircraft position or route progress is shown.</span>
      </div>
    )
  }
  const quality = effectiveFlightDataQuality(snapshot, now)
  const start = project(snapshot.origin)
  const projectedEnd = project(snapshot.destination)
  const end = { ...projectedEnd }
  if (end.x - start.x > 180) end.x -= 360
  if (end.x - start.x < -180) end.x += 360
  const control = {
    x: (start.x + end.x) / 2,
    y: Math.max(12, Math.min(start.y, end.y) - Math.min(48, Math.abs(end.x - start.x) * 0.18)),
  }
  const timelineProgress = calculateFlightProgress(snapshot, now) / 100
  const liveMarker = snapshot.position && quality === 'live'
    ? project(snapshot.position)
    : null
  if (liveMarker && liveMarker.x - start.x > 180) liveMarker.x -= 360
  if (liveMarker && liveMarker.x - start.x < -180) liveMarker.x += 360
  const marker = liveMarker
    ? liveMarker
    : pointOnQuadratic(start, control, end, timelineProgress)
  const markerDescription = liveMarker
    ? 'The airplane marker is the latest reported live position.'
    : `The airplane marker is ${quality === 'estimated' ? 'an estimated' : 'a scheduled'} timeline position, not live GPS.`
  const tangent = {
    x: 2 * (1 - timelineProgress) * (control.x - start.x)
      + 2 * timelineProgress * (end.x - control.x),
    y: 2 * (1 - timelineProgress) * (control.y - start.y)
      + 2 * timelineProgress * (end.y - control.y),
  }
  const rotation = quality === 'live'
    && typeof snapshot.position?.headingDegrees === 'number'
    ? snapshot.position.headingDegrees - 90
    : Math.atan2(tangent.y, tangent.x) * 180 / Math.PI
  const shifts = [-360, 0, 360]

  return (
    <figure className="flight-map">
      <svg
        viewBox="0 0 360 180"
        role="img"
        aria-labelledby={`flight-map-title-${flight.id}`}
      >
        <title id={`flight-map-title-${flight.id}`}>
          {flight.flightNumber} route from {snapshot.origin.code} to {snapshot.destination.code}
        </title>
        <g className="flight-map__land" aria-hidden="true">
          <path d="M8 55 22 41l22-8 23 7 13 17-8 15-20 4-12 22-18 5-9-20Zm73 68 16 8 9 24-5 18-10-19-12-12Zm61-82 22-17 29-5 18 9 28-4 24 10 17 18-7 12-25-5-16 12-20-6-15 15-17-7-10-21-22 2Zm89 65 15-14 24 5 19 24-12 26-18 8-13-19-19-7Zm68-43 19-14 24 3 10 13-9 10-26-1Z" />
        </g>
        {shifts.map((shift) => (
          <path
            key={`route-${shift}`}
            className="flight-map__route"
            d={`M ${start.x + shift} ${start.y} Q ${control.x + shift} ${control.y} ${end.x + shift} ${end.y}`}
            aria-hidden="true"
          />
        ))}
        {shifts.map((shift) => (
          <g key={`airports-${shift}`} aria-hidden="true">
            <circle className="flight-map__airport" cx={start.x + shift} cy={start.y} r="3" />
            <circle className="flight-map__airport" cx={end.x + shift} cy={end.y} r="3" />
          </g>
        ))}
        {shifts.map((shift) => (
          <g
            key={`plane-${shift}`}
            className="flight-map__plane"
            transform={`translate(${marker.x + shift} ${marker.y}) rotate(${rotation})`}
            aria-hidden="true"
          >
            <path d="M7 1.5 2.4-.3V-4c0-.7-.6-1.7-1.3-1.7S-.2-4.7-.2-4v3.7l-4.7 1.8c-.3.1-.4.4-.4.7l.2.7c.1.3.3.4.6.4l4.4-.7v2.5l-1.4 1c-.2.1-.3.3-.2.5l.1.5c.1.2.3.3.5.3l2.2-.5 2.2.5c.2 0 .4-.1.5-.3l.1-.5c.1-.2 0-.4-.2-.5l-1.4-1V2.6l4.4.7c.3 0 .5-.1.6-.4l.2-.7c0-.3-.2-.6-.5-.7Z" />
          </g>
        ))}
      </svg>
      <div className="flight-map__codes" aria-hidden="true">
        <span>{snapshot.origin.code}</span>
        <span>{snapshot.destination.code}</span>
      </div>
      <figcaption>{markerDescription}</figcaption>
    </figure>
  )
}

export function FlightTrackerSection(props: FlightTrackerSectionProps = {}) {
  const { user } = useAuth()
  const { snapshot } = useFamilyOnboarding()
  const familyId = snapshot?.kind === 'member'
    ? snapshot.membership.familyId
    : null
  const flightSubject = familyFlightStorageSubject(user?.id, familyId)

  useEffect(() => {
    const previousSubject = readActiveFlightStorageSubject()
    writeActiveFlightStorageSubject(flightSubject)
    if (!previousSubject || previousSubject === flightSubject) return
    for (const flight of readTrackedFlights(previousSubject)) {
      // Cancel every deterministic ID. This also covers a schedule that
      // succeeded just before its local `notificationEnabled` write failed.
      void cancelFlightNotifications(flight.id, previousSubject)
    }
  }, [flightSubject])

  return (
    <FlightTrackerBody
      key={flightSubject}
      {...props}
      flightSubject={flightSubject}
      displayName={user?.displayName ?? null}
    />
  )
}

function FlightTrackerBody({
  now: suppliedNow,
  flightSubject,
  displayName,
}: FlightTrackerSectionProps & {
  flightSubject: string
  displayName: string | null
}) {
  const [clock, setClock] = useState(() => suppliedNow ?? new Date())
  const now = suppliedNow ?? clock
  const formDescriptionId = useId()
  const formErrorId = useId()
  const addCloseRef = useRef<HTMLButtonElement>(null)
  const detailCloseRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [flights, setFlights] = useState<TrackedFlight[]>(() =>
    readTrackedFlights(flightSubject),
  )
  const flightsRef = useRef(flights)
  const localMutationRevisionRef = useRef(0)
  const familyFetchGenerationRef = useRef(0)
  const bodyActiveRef = useRef(true)
  const addRequestRef = useRef<AbortController | null>(null)
  const refreshRequestRef = useRef<AbortController | null>(null)
  const deleteRequestRef = useRef<AbortController | null>(null)
  const automaticRequestRefs = useRef(new Set<AbortController>())
  flightsRef.current = flights
  const [showAddFlight, setShowAddFlight] = useState(false)
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [formError, setFormError] = useState<FormError | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const portalTarget = document.querySelector<HTMLElement>('.app-viewport')
    ?? document.body

  const selectedFlight = useMemo(
    () => flights.find((flight) => flight.id === selectedFlightId) ?? null,
    [flights, selectedFlightId],
  )
  const selectedDeparture = selectedFlight
    ? formatFlightDateTime(
        flightDepartureTime(selectedFlight.snapshot),
        selectedFlight.snapshot.origin.timeZone,
      )
    : null
  const selectedArrival = selectedFlight
    ? formatFlightDateTime(
        flightArrivalTime(selectedFlight.snapshot),
        selectedFlight.snapshot.destination.timeZone,
      )
    : null

  const updateFlights = useCallback((
    updater: (current: TrackedFlight[]) => TrackedFlight[],
  ) => {
    localMutationRevisionRef.current += 1
    familyFetchGenerationRef.current += 1
    setFlights((current) => {
      const saved = writeTrackedFlights(flightSubject, updater(current))
      flightsRef.current = saved
      return saved
    })
  }, [flightSubject])

  useEffect(() => {
    bodyActiveRef.current = true
    const automaticRequests = automaticRequestRefs.current
    return () => {
      bodyActiveRef.current = false
      familyFetchGenerationRef.current += 1
      addRequestRef.current?.abort()
      refreshRequestRef.current?.abort()
      deleteRequestRef.current?.abort()
      for (const controller of automaticRequests) controller.abort()
      automaticRequests.clear()
    }
  }, [])

  useEffect(() => {
    let active = true
    let unsubscribe: () => void = () => undefined
    async function refreshFamily() {
      const requestGeneration = familyFetchGenerationRef.current + 1
      familyFetchGenerationRef.current = requestGeneration
      const mutationRevision = localMutationRevisionRef.current
      try {
        const shared = await fetchFamilyFlights()
        if (
          !active
          || requestGeneration !== familyFetchGenerationRef.current
          || mutationRevision !== localMutationRevisionRef.current
        ) return
        setFlights((current) => {
          if (
            !active
            || requestGeneration !== familyFetchGenerationRef.current
            || mutationRevision !== localMutationRevisionRef.current
          ) return current
          const sharedIds = new Set(shared.map((flight) => flight.id))
          for (const removed of current) {
            if (
              removed.synced
              && !sharedIds.has(removed.id)
              && removed.notificationEnabled
            ) void cancelFlightNotifications(removed.id, flightSubject)
          }
          const merged = mergeTrackedFlights(current, shared)
          writeTrackedFlights(flightSubject, merged)
          flightsRef.current = merged
          for (const updated of merged) {
            const previous = current.find((flight) => flight.id === updated.id)
            if (
              previous?.notificationEnabled
              && previous.snapshot.updatedAt !== updated.snapshot.updatedAt
            ) {
              void rescheduleFlightNotifications(updated, flightSubject).then((enabled) => {
                if (active && !enabled) {
                  updateFlights((latest) => latest.map((flight) =>
                    flight.id === updated.id
                      ? { ...flight, notificationEnabled: false }
                      : flight,
                  ))
                }
              })
            }
          }
          return merged
        })
      } catch {
        // Account-scoped local flights remain usable while offline.
      }
    }

    void refreshFamily()
    void subscribeToFamilyFlights(() => void refreshFamily())
      .then((stop) => {
        if (active) unsubscribe = stop
        else stop()
      })
      .catch(() => undefined)

    return () => {
      active = false
      unsubscribe()
    }
  }, [flightSubject, updateFlights])

  useEffect(() => {
    if (suppliedNow) return
    const tick = () => {
      setClock(new Date())
    }
    const timer = window.setInterval(tick, 60_000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    let disposed = false
    let removeNativeListener: (() => Promise<void>) | undefined
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) tick()
    }).then((handle) => {
      if (disposed) void handle.remove()
      else removeNativeListener = handle.remove
    })
    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      if (removeNativeListener) void removeNativeListener()
    }
  }, [suppliedNow])

  useEffect(() => {
    const cancelledWithAlerts = flights.filter((flight) =>
      flight.notificationEnabled && isFlightCancelled(flight.snapshot),
    )
    if (cancelledWithAlerts.length === 0) return
    for (const flight of cancelledWithAlerts) {
      void cancelFlightNotifications(flight.id, flightSubject)
    }
    updateFlights((current) => current.map((flight) =>
      isFlightCancelled(flight.snapshot)
        ? { ...flight, notificationEnabled: false }
        : flight,
    ))
  }, [flightSubject, flights, updateFlights])

  useEffect(() => {
    if (!showAddFlight && !selectedFlight) return
    const focused = showAddFlight ? addCloseRef.current : detailCloseRef.current
    const frame = window.requestAnimationFrame(() => focused?.focus())
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const dialog = focused?.closest<HTMLElement>('[role="dialog"]')
    function closeModal() {
      if (showAddFlight) closeAddFlight()
      else closeFlightDetails()
    }
    function handleModalKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        closeModal()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable.at(-1) as HTMLElement
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleModalKey)
    let disposed = false
    let removeBackListener: (() => Promise<void>) | undefined
    void CapacitorApp.addListener('backButton', closeModal).then((handle) => {
      if (disposed) void handle.remove()
      else removeBackListener = handle.remove
    })
    return () => {
      disposed = true
      window.cancelAnimationFrame(frame)
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleModalKey)
      if (removeBackListener) void removeBackListener()
    }
  }, [selectedFlight, showAddFlight])

  useEffect(() => {
    const candidates = takeAutomaticRefreshCandidates(
      flights,
      flightSubject,
      now,
    )
    for (const flight of candidates) {
      const controller = new AbortController()
      automaticRequestRefs.current.add(controller)
      void refreshTrackedFamilyFlight(
        flight.id,
        flight.flightNumber,
        { signal: controller.signal },
      )
        .then(async (snapshot) => {
          if (!bodyActiveRef.current || controller.signal.aborted) return
          const current = flightsRef.current.find((item) => item.id === flight.id)
          if (!current) return
          const refreshed = { ...current, snapshot, synced: true }
          const notificationsRemainEnabled = current.notificationEnabled
            ? await rescheduleFlightNotifications(refreshed, flightSubject)
            : false
          if (!bodyActiveRef.current || controller.signal.aborted) {
            if (notificationsRemainEnabled) {
              await cancelFlightNotifications(flight.id, flightSubject)
            }
            return
          }
          updateFlights((latest) => latest.map((item) => item.id === flight.id
              ? {
                  ...item,
                  snapshot,
                  synced: true,
                  notificationEnabled: current.notificationEnabled
                    ? notificationsRemainEnabled
                    : item.notificationEnabled,
                }
              : item,
            ))
        })
        .catch(() => undefined)
        .finally(() => automaticRequestRefs.current.delete(controller))
    }
  }, [flightSubject, flights, now, updateFlights])

  async function addFlight(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatusMessage('')
    const form = new FormData(event.currentTarget)
    const validation = validateFlightForm({
      travelerName: String(form.get('travelerName') ?? ''),
      flightNumber: String(form.get('flightNumber') ?? ''),
      travelDate: String(form.get('travelDate') ?? ''),
    }, now)
    if (!validation.valid) {
      setFormError(validation)
      return
    }

    setFormError(null)
    const identity = validation.value
    const id = getOrCreatePendingFlightCreateId(
      flightSubject,
      identity,
      createTrackedFlightId,
    )
    const controller = new AbortController()
    addRequestRef.current?.abort()
    addRequestRef.current = controller
    setSaving(true)
    try {
      const snapshot = await createTrackedFamilyFlight({
        id,
        travelerName: identity.travelerName,
        flightNumber: identity.flightNumber,
        travelDate: identity.travelDate,
        clientCalendarDate: localCalendarDate(now),
      }, { signal: controller.signal })
      if (
        !bodyActiveRef.current
        || controller.signal.aborted
        || addRequestRef.current !== controller
      ) return
      clearPendingFlightCreateIntent(flightSubject, identity)
      const flight: TrackedFlight = {
        id,
        travelerName: identity.travelerName,
        flightNumber: identity.flightNumber,
        travelDate: identity.travelDate,
        createdAt: new Date().toISOString(),
        snapshot,
        notificationEnabled: false,
        synced: true,
      }
      updateFlights((current) => {
        const hydrated = current.find((item) => item.id === flight.id)
        return [
          ...current.filter((item) => item.id !== flight.id),
          {
            ...flight,
            notificationEnabled: hydrated?.notificationEnabled ?? false,
          },
        ]
      })
      closeAddFlight()
      setStatusMessage(`${flight.flightNumber} is now tracked for ${flight.travelerName}.`)
    } catch (error) {
      if (
        error instanceof FlightStatusError
        && (error.code === 'invalid' || error.code === 'not-found')
      ) {
        clearPendingFlightCreateIntent(flightSubject, identity)
      }
      if (
        controller.signal.aborted
        || addRequestRef.current !== controller
        || (error instanceof FlightStatusError && error.code === 'cancelled')
      ) return
      const field = error instanceof FlightStatusError
        && (error.code === 'invalid' || error.code === 'not-found')
        ? 'flightNumber'
        : null
      setFormError({
        field,
        message: error instanceof Error
          ? error.message
          : 'The flight could not be found. Check the number and date.',
      })
    } finally {
      if (addRequestRef.current === controller) {
        addRequestRef.current = null
        if (bodyActiveRef.current) setSaving(false)
      }
    }
  }

  async function refreshFlight(flight: TrackedFlight) {
    const controller = new AbortController()
    refreshRequestRef.current?.abort()
    refreshRequestRef.current = controller
    setRefreshingId(flight.id)
    setStatusMessage('')
    try {
      const snapshot = await refreshTrackedFamilyFlight(
        flight.id,
        flight.flightNumber,
        { signal: controller.signal },
      )
      if (
        !bodyActiveRef.current
        || controller.signal.aborted
        || refreshRequestRef.current !== controller
      ) return
      const latest = flightsRef.current.find((item) => item.id === flight.id)
      if (!latest) return
      const nextFlight = { ...latest, snapshot, synced: true }
      const notificationsRemainEnabled = latest.notificationEnabled
        ? await rescheduleFlightNotifications(nextFlight, flightSubject)
        : false
      if (
        !bodyActiveRef.current
        || controller.signal.aborted
        || refreshRequestRef.current !== controller
      ) {
        if (notificationsRemainEnabled) {
          await cancelFlightNotifications(flight.id, flightSubject)
        }
        return
      }
      updateFlights((current) => current.map((item) => item.id === flight.id
        ? {
            ...item,
            snapshot,
            synced: true,
            notificationEnabled: latest.notificationEnabled
              ? notificationsRemainEnabled
              : item.notificationEnabled,
          }
        : item,
      ))
      setStatusMessage(`${flight.flightNumber} was updated at ${formatUpdatedAt(snapshot.updatedAt)}.`)
    } catch (error) {
      if (
        controller.signal.aborted
        || refreshRequestRef.current !== controller
        || (error instanceof FlightStatusError && error.code === 'cancelled')
      ) return
      setStatusMessage(error instanceof Error ? error.message : 'Flight status could not be refreshed.')
    } finally {
      if (refreshRequestRef.current === controller) {
        refreshRequestRef.current = null
        if (bodyActiveRef.current) setRefreshingId(null)
      }
    }
  }

  async function toggleNotifications(flight: TrackedFlight) {
    setStatusMessage('')
    if (isFlightCancelled(flight.snapshot)) {
      await cancelFlightNotifications(flight.id, flightSubject)
      if (!bodyActiveRef.current) return
      updateFlights((current) => current.map((item) =>
        item.id === flight.id ? { ...item, notificationEnabled: false } : item,
      ))
      setStatusMessage('Alerts stay off because this flight was cancelled.')
      return
    }
    if (flight.notificationEnabled) {
      await cancelFlightNotifications(flight.id, flightSubject)
      if (!bodyActiveRef.current) return
      updateFlights((current) => current.map((item) =>
        item.id === flight.id ? { ...item, notificationEnabled: false } : item,
      ))
      setStatusMessage(`Flight alerts are off for ${flight.flightNumber}.`)
      return
    }
    const result = await enableFlightNotifications(flight, flightSubject)
    if (!bodyActiveRef.current) {
      if (result.enabled) {
        await cancelFlightNotifications(flight.id, flightSubject)
      }
      return
    }
    if (result.enabled) {
      updateFlights((current) => current.map((item) =>
        item.id === flight.id ? { ...item, notificationEnabled: true } : item,
      ))
    }
    setStatusMessage(result.message)
  }

  function openAddFlight() {
    returnFocusRef.current = document.activeElement as HTMLElement | null
    setFormError(null)
    setStatusMessage('')
    setShowAddFlight(true)
  }

  function closeAddFlight() {
    addRequestRef.current?.abort()
    addRequestRef.current = null
    setSaving(false)
    setShowAddFlight(false)
    window.requestAnimationFrame(() => returnFocusRef.current?.focus())
  }

  function openFlightDetails(flightId: string) {
    returnFocusRef.current = document.activeElement as HTMLElement | null
    setConfirmDeleteId(null)
    setSelectedFlightId(flightId)
  }

  function closeFlightDetails() {
    refreshRequestRef.current?.abort()
    refreshRequestRef.current = null
    deleteRequestRef.current?.abort()
    deleteRequestRef.current = null
    setRefreshingId(null)
    setDeletingId(null)
    setConfirmDeleteId(null)
    setSelectedFlightId(null)
    window.requestAnimationFrame(() => returnFocusRef.current?.focus())
  }

  async function stopTracking(flight: TrackedFlight) {
    const controller = new AbortController()
    deleteRequestRef.current?.abort()
    deleteRequestRef.current = controller
    setDeletingId(flight.id)
    setStatusMessage('')
    try {
      if (flight.synced) {
        const removed = await removeFamilyFlight(
          flight.id,
          { signal: controller.signal },
        )
        if (!removed) throw new Error('flight_storage_unavailable')
      }
      if (
        !bodyActiveRef.current
        || controller.signal.aborted
        || deleteRequestRef.current !== controller
      ) return
      await cancelFlightNotifications(flight.id, flightSubject)
      if (
        !bodyActiveRef.current
        || controller.signal.aborted
        || deleteRequestRef.current !== controller
      ) return
      updateFlights((current) => current.filter((item) => item.id !== flight.id))
      closeFlightDetails()
      setStatusMessage(`${flight.flightNumber} is no longer being tracked.`)
    } catch (error) {
      if (
        controller.signal.aborted
        || deleteRequestRef.current !== controller
        || (error instanceof FlightStatusError && error.code === 'cancelled')
      ) return
      const errorMessage = error instanceof Error
        ? error.message.toLowerCase()
        : typeof error === 'object' && error !== null && 'message' in error
          ? String(error.message).toLowerCase()
          : ''
      const permissionDenied = errorMessage.includes('flight_delete_not_allowed')
        || errorMessage.includes('permission denied')
        || errorMessage.includes('not authorized')
        || errorMessage.includes('forbidden')
        || errorMessage.includes('42501')
      setStatusMessage(permissionDenied
        ? 'Only the person who added this flight or the family owner can stop tracking it. The shared card was kept.'
        : error instanceof FlightStatusError
          ? `${error.message} The shared card was kept.`
          : 'Couldn’t stop tracking while offline. Check your connection and try again; the shared card was kept.')
    } finally {
      if (deleteRequestRef.current === controller) {
        deleteRequestRef.current = null
        if (bodyActiveRef.current) setDeletingId(null)
      }
    }
  }

  return (
    <section className="flight-tracker" aria-labelledby="flight-tracker-title">
      <header className="flight-tracker__header">
        <div>
          <p>Travel</p>
          <h2 id="flight-tracker-title">Family flights</h2>
        </div>
        <button className="flight-tracker__add" type="button" onClick={openAddFlight}>
          <span aria-hidden="true">+</span>
          Add flight
        </button>
      </header>

      {flights.length === 0 ? (
        <div className="flight-empty">
          <span className="flight-empty__icon" aria-hidden="true"><PlaneIcon /></span>
          <div>
            <h3>No flights tracked</h3>
            <p>Add a flight number to keep arrival timing and travel progress together.</p>
          </div>
          <button type="button" onClick={openAddFlight}>Track a flight</button>
        </div>
      ) : (
        <ul className="flight-list">
          {flights.map((flight) => {
            const arrival = flightArrivalTime(flight.snapshot)
            const arrivalLabel = formatFlightDateTime(
              arrival,
              flight.snapshot.destination.timeZone,
            )
            const progress = calculateFlightProgress(flight.snapshot, now)
            const quality = effectiveFlightDataQuality(flight.snapshot, now)
            const cancelled = isFlightCancelled(flight.snapshot)
            return (
              <li key={flight.id}>
                <article className="flight-card">
                  <button
                    type="button"
                    className="flight-card__open"
                    aria-label={`Open ${flight.flightNumber} flight details for ${flight.travelerName}`}
                    onClick={() => openFlightDetails(flight.id)}
                  >
                    <div className="flight-card__topline">
                      <span className="flight-card__traveler">{flight.travelerName}</span>
                      <span className="flight-quality" data-quality={cancelled ? 'cancelled' : quality}>
                        {cancelled ? 'Cancelled' : qualityLabel(quality)}
                      </span>
                    </div>
                    <div className="flight-card__route">
                      <div>
                        <strong>{flight.snapshot.origin.code}</strong>
                        <span>{airportPlace(flight.snapshot, 'origin')}</span>
                      </div>
                      <span className="flight-card__number">{flight.flightNumber}</span>
                      <div>
                        <strong>{flight.snapshot.destination.code}</strong>
                        <span>{airportPlace(flight.snapshot, 'destination')}</span>
                      </div>
                    </div>
                    <FlightProgress flight={flight} now={now} />
                    <div className="flight-card__meta">
                      {cancelled ? (
                        <><span>No ETA</span><span>Flight cancelled</span></>
                      ) : (
                        <>
                          <span>{flight.snapshot.actualArrival ? 'Arrived' : 'ETA'} {arrivalLabel?.time ?? 'Not available'}</span>
                          <span>{progress}% · {flight.snapshot.status}</span>
                        </>
                      )}
                    </div>
                  </button>
                  <button
                    type="button"
                    className="flight-card__notify"
                    aria-pressed={flight.notificationEnabled}
                    aria-label={cancelled
                      ? `Alerts unavailable for cancelled ${flight.flightNumber}`
                      : `${flight.notificationEnabled ? 'Turn off alerts for' : 'Notify me about'} ${flight.flightNumber}`}
                    disabled={cancelled}
                    onClick={() => void toggleNotifications(flight)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9.5 20h5" />
                    </svg>
                    {cancelled
                      ? 'Alerts off · cancelled'
                      : flight.notificationEnabled ? 'Alerts on' : 'Notify me'}
                  </button>
                </article>
              </li>
            )
          })}
        </ul>
      )}

      {flights.length > 0 ? (
        <p className="flight-tracker__notice">
          To protect the free tracker allowance, this phone checks at most twice every six hours. Open a flight and tap Refresh status for an immediate check.
        </p>
      ) : null}

      {statusMessage && !selectedFlight ? <p className="flight-tracker__status" role="status">{statusMessage}</p> : null}

      {showAddFlight ? createPortal(
        <div className="flight-sheet" role="dialog" aria-modal="true" aria-labelledby="add-flight-title" aria-describedby={formDescriptionId}>
          <form className="flight-sheet__panel" onSubmit={(event) => void addFlight(event)}>
            <header className="flight-sheet__header">
              <div>
                <p>Travel</p>
                <h2 id="add-flight-title">Track a flight</h2>
              </div>
              <button
                ref={addCloseRef}
                type="button"
                aria-label="Close add flight"
                onClick={closeAddFlight}
              >×</button>
            </header>
            <p className="flight-sheet__intro" id={formDescriptionId}>
              Use the airline flight number and its departure or arrival date. Codeshares are matched automatically.
            </p>
            <label className="flight-field">
              <span>Traveler</span>
              <input
                name="travelerName"
                maxLength={60}
                placeholder={displayName?.split(' ')[0] || 'Name'}
                autoComplete="name"
                aria-invalid={formError?.field === 'travelerName'}
                aria-describedby={formError?.field === 'travelerName' ? formErrorId : undefined}
                required
              />
            </label>
            <label className="flight-field">
              <span>Flight number</span>
              <input
                name="flightNumber"
                aria-label="Flight number"
                maxLength={20}
                placeholder="EK202"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={formError?.field === 'flightNumber'}
                aria-describedby={formError?.field === 'flightNumber' ? formErrorId : undefined}
                required
              />
              <small>Ticket numbers cannot be tracked and are never saved.</small>
            </label>
            <label className="flight-field">
              <span>Departure or arrival date</span>
              <input
                name="travelDate"
                type="date"
                min={shiftLocalCalendarDate(now, -1)}
                max={shiftLocalCalendarDate(now, 365)}
                aria-invalid={formError?.field === 'travelDate'}
                aria-describedby={formError?.field === 'travelDate' ? formErrorId : undefined}
                required
              />
            </label>
            {formError ? <p className="flight-sheet__error" id={formErrorId} role="alert">{formError.message}</p> : null}
            <button className="flight-sheet__submit" type="submit" disabled={saving}>
              {saving ? 'Finding flight…' : 'Track flight'}
            </button>
          </form>
        </div>,
        portalTarget,
      ) : null}

      {selectedFlight ? createPortal(
        <div className="flight-detail" role="dialog" aria-modal="true" aria-labelledby="flight-detail-title">
          <div className="flight-detail__panel">
            <header className="flight-detail__header">
              <div>
                <p>{selectedFlight.travelerName} · {formatDate(selectedFlight.travelDate)}</p>
                <h2 id="flight-detail-title">{selectedFlight.flightNumber}</h2>
              </div>
              <button
                ref={detailCloseRef}
                type="button"
                aria-label="Close flight details"
                onClick={closeFlightDetails}
              >×</button>
            </header>
            <div className="flight-detail__quality">
              <span
                className="flight-quality"
                data-quality={isFlightCancelled(selectedFlight.snapshot)
                  ? 'cancelled'
                  : effectiveFlightDataQuality(selectedFlight.snapshot, now)}
              >
                {isFlightCancelled(selectedFlight.snapshot)
                  ? 'Cancelled'
                  : qualityLabel(effectiveFlightDataQuality(selectedFlight.snapshot, now))}
              </span>
              <span>{selectedFlight.snapshot.status}</span>
              {selectedFlight.snapshot.operatingFlightNumber ? (
                <span>Operated as {selectedFlight.snapshot.operatingFlightNumber}</span>
              ) : null}
            </div>
            <FlightRouteMap flight={selectedFlight} now={now} />
            <dl className="flight-detail__times">
              <div>
                <dt>Departure</dt>
                <dd>{selectedDeparture?.time ?? 'Not available'}</dd>
                <span>{selectedDeparture?.date ?? 'Date unavailable'} · {selectedFlight.snapshot.origin.code}</span>
                <small>{selectedFlight.snapshot.origin.timeZone}</small>
              </div>
              <div>
                <dt>{selectedFlight.snapshot.actualArrival ? 'Arrived' : 'Arrival'}</dt>
                <dd>{isFlightCancelled(selectedFlight.snapshot)
                  ? 'Not applicable'
                  : selectedArrival?.time ?? 'Not available'}</dd>
                <span>{isFlightCancelled(selectedFlight.snapshot)
                  ? `No arrival estimate · ${selectedFlight.snapshot.destination.code}`
                  : `${selectedArrival?.date ?? 'Date unavailable'} · ${selectedFlight.snapshot.destination.code}`}</span>
                <small>{selectedFlight.snapshot.destination.timeZone}</small>
              </div>
            </dl>
            <p className="flight-detail__updated">
              Updated {formatUpdatedAt(selectedFlight.snapshot.updatedAt)} · {selectedFlight.snapshot.provider === 'aerodatabox'
                ? 'AeroDataBox'
                : 'FlightAware AeroAPI'}
            </p>
            <div className="flight-detail__actions">
              <button
                type="button"
                className="flight-detail__refresh"
                disabled={refreshingId === selectedFlight.id || deletingId === selectedFlight.id}
                onClick={() => void refreshFlight(selectedFlight)}
              >
                {refreshingId === selectedFlight.id ? 'Updating…' : 'Refresh status'}
              </button>
              <button
                type="button"
                className="flight-detail__notify"
                aria-pressed={selectedFlight.notificationEnabled}
                disabled={deletingId === selectedFlight.id || isFlightCancelled(selectedFlight.snapshot)}
                onClick={() => void toggleNotifications(selectedFlight)}
              >
                {isFlightCancelled(selectedFlight.snapshot)
                  ? 'Alerts off · cancelled'
                  : selectedFlight.notificationEnabled ? 'Turn off alerts' : 'Notify me'}
              </button>
            </div>
            {confirmDeleteId === selectedFlight.id ? (
              <div className="flight-detail__delete-confirm" role="group" aria-label="Confirm stop tracking">
                <p>Stop sharing this flight with the family?</p>
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      deleteRequestRef.current?.abort()
                      deleteRequestRef.current = null
                      setDeletingId(null)
                      setConfirmDeleteId(null)
                    }}
                  >
                    Keep flight
                  </button>
                  <button
                    type="button"
                    className="flight-detail__delete-confirm-action"
                    disabled={deletingId === selectedFlight.id || refreshingId === selectedFlight.id}
                    onClick={() => void stopTracking(selectedFlight)}
                  >
                    {deletingId === selectedFlight.id ? 'Stopping…' : 'Yes, stop tracking'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="flight-detail__delete"
                disabled={deletingId === selectedFlight.id || refreshingId === selectedFlight.id}
                onClick={() => {
                  setStatusMessage('')
                  setConfirmDeleteId(selectedFlight.id)
                }}
              >
                Stop tracking this flight
              </button>
            )}
            {statusMessage ? <p className="flight-detail__status" role="status">{statusMessage}</p> : null}
          </div>
        </div>,
        portalTarget,
      ) : null}
    </section>
  )
}
