import {
  useCallback,
  useEffect,
  useId,
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
  type FlightLookupChoice,
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
import { readOrSeedDemoTrackedFlights } from './demoFlightData'
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
type FlightCreateIdentity = {
  travelerName: string
  flightNumber: string
  travelDate: string
}
type PendingFlightChoices = {
  id: string
  identity: FlightCreateIdentity
  choices: FlightLookupChoice[]
}

function qualityLabel(quality: FlightStatusSnapshot['dataQuality']) {
  if (quality === 'live') return 'Live'
  if (quality === 'estimated') return 'Estimated'
  return 'Scheduled'
}

function formatDayMonth(value: string) {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${value}T12:00:00`))
}

function formatTicketTime(value: string | null, timeZone: string) {
  if (!value) return null
  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(value))
}

function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatChoiceDeparture(choice: FlightLookupChoice) {
  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(choice.origin.timeZone ? { timeZone: choice.origin.timeZone } : {}),
  }).format(new Date(choice.scheduledDeparture))
}

function formatDuration(departure: string | null, arrival: string | null) {
  if (!departure || !arrival) return 'Duration unavailable'
  const minutes = Math.max(0, Math.round(
    (new Date(arrival).getTime() - new Date(departure).getTime()) / 60_000,
  ))
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return `${hours}h ${remainder}m`
}

function FlightDoodleHeader() {
  return (
    <div className="flight-doodle-header" aria-hidden="true">
      <svg className="flight-doodle-header__cloud flight-doodle-header__cloud--large" viewBox="0 0 72 30" aria-hidden="true">
        <path d="M6 23c-4-1-4-8 1-10 2-1 4 0 5 1 1-6 6-9 11-7 2-6 10-8 14-3 3-2 8-1 10 3 6-1 11 3 11 8 8-1 11 9 4 12H6Z" />
      </svg>
      <svg className="flight-doodle-header__journey" viewBox="0 0 208 58" aria-hidden="true">
        <path className="flight-doodle-header__route" d="M2 42c14-11 29-9 36 2 5 8-6 13-12 6-9-11 4-31 23-26 22 7 28 19 51 19 21 0 32-10 46-20" />
        <path className="flight-doodle-header__plane" d="m145 21 55-17-30 49-8-22-17-10Zm17 10L200 4m-33 32 1 11 8-9" />
      </svg>
      <svg className="flight-doodle-header__cloud flight-doodle-header__cloud--small" viewBox="0 0 72 30" aria-hidden="true">
        <path d="M6 23c-4-1-4-8 1-10 2-1 4 0 5 1 1-6 6-9 11-7 2-6 10-8 14-3 3-2 8-1 10 3 6-1 11 3 11 8 8-1 11 9 4 12H6Z" />
      </svg>
    </div>
  )
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

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 7v5h-5M4 17v-5h5M6.1 9A7 7 0 0 1 18 6l2 1M17.9 15A7 7 0 0 1 6 18l-2-1" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  )
}

function FlightRouteMark({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      className={compact ? 'flight-route-mark flight-route-mark--compact' : 'flight-route-mark'}
      viewBox="0 0 100 24"
      aria-hidden="true"
    >
      <line className="flight-route-mark__dots" x1="2" y1="12" x2="98" y2="12" />
      <circle className="flight-route-mark__mask" cx="50" cy="12" r={compact ? 7.5 : 9} />
      <g className="flight-route-mark__plane" transform="translate(50 12) rotate(90) scale(.62) translate(-12 -12)">
        <path d="M21.4 13.2 14 10.4V4.7c0-1.1-.9-2.7-2-2.7s-2 1.6-2 2.7v5.7l-7.4 2.8c-.4.2-.7.6-.6 1.1l.2 1.1c.1.4.5.7.9.6l6.9-1.1v4l-2.1 1.5c-.3.2-.4.5-.3.8l.2.7c.1.3.4.5.8.4l3.4-.8 3.4.8c.4.1.7-.1.8-.4l.2-.7c.1-.3 0-.6-.3-.8L14 18.9v-4l6.9 1.1c.4.1.8-.2.9-.6l.2-1.1c.1-.5-.2-.9-.6-1.1Z" />
      </g>
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
  const { user, isDevelopmentPreview } = useAuth()
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
      demoMode={isDevelopmentPreview === true}
    />
  )
}

function FlightTrackerBody({
  now: suppliedNow,
  flightSubject,
  demoMode,
}: FlightTrackerSectionProps & {
  flightSubject: string
  demoMode: boolean
}) {
  const [clock, setClock] = useState(() => suppliedNow ?? new Date())
  const now = suppliedNow ?? clock
  const formDescriptionId = useId()
  const formErrorId = useId()
  const addCloseRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [flights, setFlights] = useState<TrackedFlight[]>(() => demoMode
    ? readOrSeedDemoTrackedFlights(flightSubject, suppliedNow)
    : readTrackedFlights(flightSubject))
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
  const [saving, setSaving] = useState(false)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [notificationPendingId, setNotificationPendingId] = useState<string | null>(null)
  const [expandedFlightId, setExpandedFlightId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [pendingFlightChoices, setPendingFlightChoices] = useState<PendingFlightChoices | null>(null)
  const [formError, setFormError] = useState<FormError | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const portalTarget = document.querySelector<HTMLElement>('.app-viewport')
    ?? document.body

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
    if (!showAddFlight) return
    const focused = addCloseRef.current
    const dialog = focused?.closest<HTMLElement>('[role="dialog"]')
    const frame = window.requestAnimationFrame(() => {
      // Do not steal focus if the user has already tapped or started typing in
      // the sheet before this accessibility focus frame runs.
      if (!dialog?.contains(document.activeElement)) focused?.focus()
    })
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function closeModal() {
      closeAddFlight()
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
  }, [showAddFlight])

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

  async function requestFlightCreate(
    identity: FlightCreateIdentity,
    id: string,
    providerFlightId?: string,
  ) {
    const controller = new AbortController()
    addRequestRef.current?.abort()
    addRequestRef.current = controller
    setSaving(true)
    try {
      const result = await createTrackedFamilyFlight({
        id,
        travelerName: identity.travelerName,
        flightNumber: identity.flightNumber,
        travelDate: identity.travelDate,
        clientCalendarDate: localCalendarDate(now),
        ...(providerFlightId ? { providerFlightId } : {}),
      }, { signal: controller.signal })
      if (
        !bodyActiveRef.current
        || controller.signal.aborted
        || addRequestRef.current !== controller
      ) return
      if (result.kind === 'choices') {
        setPendingFlightChoices({ id, identity, choices: result.choices })
        return
      }
      const { snapshot: createdSnapshot } = result
      clearPendingFlightCreateIntent(flightSubject, identity)
      const flight: TrackedFlight = {
        id,
        travelerName: identity.travelerName,
        flightNumber: identity.flightNumber,
        travelDate: identity.travelDate,
        createdAt: new Date().toISOString(),
        snapshot: createdSnapshot,
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
      setPendingFlightChoices(null)
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

  async function addFlight(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pendingFlightChoices) return
    setStatusMessage('')
    const form = new FormData(event.currentTarget)
    const optionalHeader = String(form.get('travelerName') ?? '')
      .trim()
      .replace(/\s+/g, ' ')
    const validation = validateFlightForm({
      // The persisted API field is still named travelerName for backward
      // compatibility, but the UI treats it as an optional card header.
      travelerName: optionalHeader || 'Family flight',
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
    await requestFlightCreate(identity, id)
  }

  async function chooseFlight(choice: FlightLookupChoice) {
    if (!pendingFlightChoices || saving) return
    setFormError(null)
    await requestFlightCreate(
      pendingFlightChoices.identity,
      pendingFlightChoices.id,
      choice.providerFlightId,
    )
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
    if (notificationPendingId) return
    setStatusMessage('')
    setNotificationPendingId(flight.id)
    try {
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
    } catch {
      if (!bodyActiveRef.current) return
      setStatusMessage('Flight alerts could not be changed. Check notification permission and try again.')
    } finally {
      if (bodyActiveRef.current) setNotificationPendingId(null)
    }
  }

  function openAddFlight() {
    returnFocusRef.current = document.activeElement as HTMLElement | null
    setPendingFlightChoices(null)
    setFormError(null)
    setStatusMessage('')
    setShowAddFlight(true)
  }

  function closeAddFlight() {
    addRequestRef.current?.abort()
    addRequestRef.current = null
    setSaving(false)
    setPendingFlightChoices(null)
    setShowAddFlight(false)
    window.requestAnimationFrame(() => returnFocusRef.current?.focus())
  }

  function toggleFlightActions(flightId: string) {
    setStatusMessage('')
    setConfirmDeleteId(null)
    setExpandedFlightId((current) => current === flightId ? null : flightId)
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
      setConfirmDeleteId(null)
      setExpandedFlightId((current) => current === flight.id ? null : current)
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

  function openDeleteConfirmation(flightId: string) {
    setStatusMessage('')
    setExpandedFlightId(flightId)
    setConfirmDeleteId(flightId)
  }

  function flightToolbar(flight: TrackedFlight, cancelled: boolean) {
    const changingAlerts = notificationPendingId === flight.id
    const refreshing = refreshingId === flight.id
    const deleting = deletingId === flight.id
    return (
      <div className="flight-card__toolbar" aria-label={`${flight.flightNumber} controls`}>
        <button
          type="button"
          className="flight-card__icon-action flight-card__icon-action--notify"
          aria-label={cancelled
            ? `Alerts unavailable for cancelled ${flight.flightNumber}`
            : changingAlerts
              ? `Changing alerts for ${flight.flightNumber}`
              : `${flight.notificationEnabled ? 'Turn off' : 'Turn on'} alerts for ${flight.flightNumber}`}
          aria-pressed={flight.notificationEnabled}
          disabled={notificationPendingId !== null || deleting || cancelled}
          onClick={() => void toggleNotifications(flight)}
        >
          <BellIcon />
        </button>
        <button
          type="button"
          className="flight-card__icon-action"
          aria-label={refreshing ? `Refreshing ${flight.flightNumber}` : `Refresh ${flight.flightNumber}`}
          disabled={refreshing || deleting}
          onClick={() => void refreshFlight(flight)}
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          className="flight-card__icon-action flight-card__icon-action--remove"
          aria-label={`Stop tracking ${flight.flightNumber}`}
          disabled={refreshing || deleting}
          onClick={() => openDeleteConfirmation(flight.id)}
        >
          <CloseIcon />
        </button>
      </div>
    )
  }

  function flightDetails(
    flight: TrackedFlight,
    quality: FlightStatusSnapshot['dataQuality'],
    cancelled: boolean,
  ) {
    const departure = formatFlightDateTime(
      flightDepartureTime(flight.snapshot),
      flight.snapshot.origin.timeZone,
    )
    const arrival = formatFlightDateTime(
      flightArrivalTime(flight.snapshot),
      flight.snapshot.destination.timeZone,
    )
    return (
      <section
        className="flight-card__details"
        id={`flight-details-${flight.id}`}
        aria-label={`${flight.flightNumber} full flight information`}
      >
        <div className="flight-detail__quality">
          <span className="flight-quality" data-quality={cancelled ? 'cancelled' : quality}>
            {cancelled ? 'Cancelled' : qualityLabel(quality)}
          </span>
          <span>{flight.snapshot.status}</span>
          {flight.snapshot.operatingFlightNumber ? (
            <span>Operated as {flight.snapshot.operatingFlightNumber}</span>
          ) : null}
        </div>
        <div
          className="flight-detail__route"
          role="group"
          aria-label={`${flight.snapshot.origin.code} to ${flight.snapshot.destination.code}`}
        >
          <div>
            <strong>{flight.snapshot.origin.code}</strong>
            <span>{airportPlace(flight.snapshot, 'origin')}</span>
          </div>
          <FlightRouteMark />
          <div>
            <strong>{flight.snapshot.destination.code}</strong>
            <span>{airportPlace(flight.snapshot, 'destination')}</span>
          </div>
        </div>
        <FlightRouteMap flight={flight} now={now} />
        <dl className="flight-detail__times">
          <div>
            <dt>Departure</dt>
            <dd>{departure?.time ?? 'Not available'}</dd>
            <span>{departure?.date ?? 'Date unavailable'} · {flight.snapshot.origin.code}</span>
            <small>{flight.snapshot.origin.timeZone}</small>
          </div>
          <div>
            <dt>{flight.snapshot.actualArrival ? 'Arrived' : 'Arrival'}</dt>
            <dd>{cancelled ? 'Not applicable' : arrival?.time ?? 'Not available'}</dd>
            <span>{cancelled
              ? `No arrival estimate · ${flight.snapshot.destination.code}`
              : `${arrival?.date ?? 'Date unavailable'} · ${flight.snapshot.destination.code}`}</span>
            <small>{flight.snapshot.destination.timeZone}</small>
          </div>
        </dl>
        <p className="flight-detail__updated">
          Updated {formatUpdatedAt(flight.snapshot.updatedAt)} · {flight.snapshot.provider === 'aerodatabox'
            ? 'AeroDataBox'
            : 'FlightAware AeroAPI'}
        </p>
        {confirmDeleteId === flight.id ? (
          <div className="flight-detail__delete-confirm" role="group" aria-label={`Confirm stop tracking ${flight.flightNumber}`}>
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
                disabled={deletingId === flight.id || refreshingId === flight.id}
                onClick={() => void stopTracking(flight)}
              >
                {deletingId === flight.id ? 'Stopping…' : 'Yes, stop tracking'}
              </button>
            </div>
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <section className="flight-tracker" aria-labelledby="flight-tracker-title">
      <h2 className="flight-tracker__sr-only" id="flight-tracker-title">Family flights</h2>
      <FlightDoodleHeader />
      <header className="flight-tracker__collection-header">
        <div>
          <p>Shared itinerary</p>
          <h3>Upcoming flights</h3>
        </div>
        <button type="button" onClick={openAddFlight} aria-label="Add flight">
          <span aria-hidden="true">＋</span>
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
          {flights.map((flight, index) => {
            const departure = flightDepartureTime(flight.snapshot)
            const arrival = flightArrivalTime(flight.snapshot)
            const quality = effectiveFlightDataQuality(flight.snapshot, now)
            const cancelled = isFlightCancelled(flight.snapshot)
            const featured = index === 0
            const duration = formatDuration(departure, arrival)
            const expanded = expandedFlightId === flight.id
            return (
              <li className={featured ? 'flight-list__featured' : 'flight-list__compact'} key={flight.id}>
                <article
                  className={featured
                    ? 'flight-card flight-card--featured'
                    : 'flight-card flight-card--compact'}
                  data-cancelled={cancelled ? 'true' : 'false'}
                  data-expanded={expanded ? 'true' : 'false'}
                >
                  {flightToolbar(flight, cancelled)}
                  {featured ? (
                    <>
                    <div className="flight-card__topline">
                      <div className="flight-card__identity">
                        <span className="flight-card__traveler">{flight.travelerName}</span>
                        <span className="flight-card__number">{flight.flightNumber}</span>
                        {!cancelled ? <span className="flight-tracker__sr-only">{qualityLabel(quality)}</span> : null}
                        <span className="flight-card__status" data-quality={cancelled ? 'cancelled' : quality}>
                          <i aria-hidden="true" />
                          {cancelled ? 'Cancelled' : flight.snapshot.status}
                        </span>
                      </div>
                    </div>
                    <div className="flight-card__route">
                      <div>
                        <strong>{flight.snapshot.origin.code}</strong>
                        <span>{airportPlace(flight.snapshot, 'origin')}</span>
                      </div>
                      <FlightRouteMark />
                      <div>
                        <strong>{flight.snapshot.destination.code}</strong>
                        <span>{airportPlace(flight.snapshot, 'destination')}</span>
                      </div>
                    </div>
                    <div className="flight-card__times">
                      <div>
                        <span>Depart</span>
                        <strong>{formatTicketTime(departure, flight.snapshot.origin.timeZone) ?? 'Not available'}</strong>
                        <small>{formatDayMonth(flight.travelDate)}</small>
                      </div>
                      <span className="flight-card__duration">{duration} · Direct</span>
                      <div>
                        <span>{flight.snapshot.actualArrival ? 'Arrived' : 'Arrive'}</span>
                        <strong>{cancelled ? '—' : formatTicketTime(arrival, flight.snapshot.destination.timeZone) ?? 'Not available'}</strong>
                        <small>{cancelled ? 'No estimate' : formatDayMonth(flight.travelDate)}</small>
                        {cancelled ? <span className="flight-tracker__sr-only">No ETA</span> : null}
                      </div>
                    </div>
                    <FlightProgress flight={flight} now={now} />
                    <div
                      className="flight-card__progress-codes"
                      data-origin={flight.snapshot.origin.code}
                      data-destination={flight.snapshot.destination.code}
                      aria-hidden="true"
                    />
                    </>
                  ) : (
                    <div
                      className="flight-card__compact-open"
                    >
                      <span className="flight-card__compact-route">
                        <span>
                          <strong>{flight.snapshot.origin.code}</strong>
                          <span className="flight-card__compact-number">{flight.flightNumber}</span>
                          <small>{airportPlace(flight.snapshot, 'origin')}</small>
                        </span>
                        <FlightRouteMark compact />
                        <span>
                          <strong>{flight.snapshot.destination.code}</strong>
                          <small>{airportPlace(flight.snapshot, 'destination')}</small>
                        </span>
                      </span>
                      <span className="flight-card__compact-date">
                        <small>{formatDayMonth(flight.travelDate)}</small>
                        <strong>{formatTicketTime(departure, flight.snapshot.origin.timeZone) ?? '—'}</strong>
                      </span>
                      <span className="flight-card__compact-meta">
                        <span className="flight-quality" data-quality={cancelled ? 'cancelled' : quality}>
                          {cancelled ? 'Cancelled' : qualityLabel(quality)}
                        </span>
                        <span>{duration} · Direct</span>
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    className="flight-card__expand"
                    aria-label={`${expanded ? 'Hide' : 'Show'} all info for ${flight.flightNumber}`}
                    aria-expanded={expanded}
                    aria-controls={`flight-details-${flight.id}`}
                    onClick={() => toggleFlightActions(flight.id)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                  {expanded ? flightDetails(flight, quality, cancelled) : null}
                </article>
              </li>
            )
          })}
        </ul>
      )}

      {statusMessage ? <p className="flight-tracker__status" role="status">{statusMessage}</p> : null}

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
              Use the airline flight number and the departure date in the airport’s local time. Codeshares are matched automatically.
            </p>
            <label className="flight-field">
              <span>Header <small>(optional)</small></span>
              <input
                name="travelerName"
                maxLength={60}
                placeholder="Family trip"
                disabled={pendingFlightChoices !== null}
                aria-invalid={formError?.field === 'travelerName'}
                aria-describedby={formError?.field === 'travelerName' ? formErrorId : undefined}
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
                disabled={pendingFlightChoices !== null}
                aria-invalid={formError?.field === 'flightNumber'}
                aria-describedby={formError?.field === 'flightNumber' ? formErrorId : undefined}
                required
              />
              <small>Ticket numbers cannot be tracked and are never saved.</small>
            </label>
            <label className="flight-field">
              <span>Departure date</span>
              <input
                name="travelDate"
                type="date"
                aria-label="Departure date"
                min={shiftLocalCalendarDate(now, -1)}
                max={shiftLocalCalendarDate(now, 365)}
                disabled={pendingFlightChoices !== null}
                aria-invalid={formError?.field === 'travelDate'}
                aria-describedby={formError?.field === 'travelDate' ? formErrorId : undefined}
                required
              />
              <small>Choose the calendar date where the flight leaves, in the departure airport’s local time.</small>
            </label>
            {pendingFlightChoices ? (
              <section className="flight-choice" aria-labelledby="flight-choice-title">
                <div className="flight-choice__header">
                  <div>
                    <p>Double-check the departure</p>
                    <h3 id="flight-choice-title">
                      We found {pendingFlightChoices.choices.length} flights that day
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingFlightChoices(null)}
                  >
                    Change search
                  </button>
                </div>
                <div className="flight-choice__list">
                  {pendingFlightChoices.choices.map((choice) => (
                    <button
                      type="button"
                      key={choice.providerFlightId}
                      disabled={saving}
                      aria-label={`Choose ${choice.origin.code} to ${choice.destination.code}, departing ${formatChoiceDeparture(choice)}`}
                      onClick={() => void chooseFlight(choice)}
                    >
                      <span className="flight-choice__route">
                        <strong>{choice.origin.code}</strong>
                        <FlightRouteMark compact />
                        <strong>{choice.destination.code}</strong>
                      </span>
                      <span>{formatChoiceDeparture(choice)}</span>
                      {choice.operatingFlightNumber ? (
                        <small>Operated as {choice.operatingFlightNumber}</small>
                      ) : null}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            {formError ? <p className="flight-sheet__error" id={formErrorId} role="alert">{formError.message}</p> : null}
            {!pendingFlightChoices ? (
              <button className="flight-sheet__submit" type="submit" disabled={saving}>
                {saving ? 'Finding flight…' : 'Track flight'}
              </button>
            ) : null}
          </form>
        </div>,
        portalTarget,
      ) : null}
    </section>
  )
}
