import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { App as CapacitorApp } from '@capacitor/app'
import { subscribeToAppResume } from '../../lib/appResume'
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
  isFlightCancelled,
  localCalendarDate,
  validateFlightForm,
} from './flightValidation'
import type { TrackedFlight } from './types'
import { FlightDoodleHeader, PlaneIcon } from './FlightArtwork'
import { FlightTicket } from './FlightTicket'
import { FlightLookupSheet, type FlightLookupFormError } from './FlightLookupSheet'
import { formatUpdatedAt } from './flightPresentation'
import './FlightTrackerSection.css'

export type FlightTrackerSectionProps = {
  now?: Date
}

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


/**
 * Coordinates family flight lookup, local caching, automatic refresh budgets,
 * realtime updates, and device-local alert preferences.
 */
export function FlightTrackerSection(props: FlightTrackerSectionProps = {}) {
  const { user, isDevelopmentPreview } = useAuth()
  const { snapshot } = useFamilyOnboarding()
  const familyId = snapshot?.kind === 'member'
    ? snapshot.membership.familyId
    : null
  const flightSubject = familyFlightStorageSubject(user?.id, familyId)

  // Notification IDs are device-local, so switching subjects must cancel the
  // previous account's schedules before the new body becomes authoritative.
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

/** Owns mutable flight state for exactly one account/family cache namespace. */
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
  const notificationRequestRef = useRef<string | null>(null)
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
  const [formError, setFormError] = useState<FlightLookupFormError | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const portalTarget = document.querySelector<HTMLElement>('.app-viewport')
    ?? document.body

  /** Applies a local mutation and atomically advances stale-fetch guards. */
  const updateFlights = useCallback((
    updater: (current: TrackedFlight[]) => TrackedFlight[],
  ) => {
    // The account-scoped cache is the immediate source of truth while the
    // family backend is offline. Advance both revisions before React queues
    // the state update so a family fetch that started earlier cannot land in
    // the small gap between a successful mutation and its local persistence.
    localMutationRevisionRef.current += 1
    familyFetchGenerationRef.current += 1
    setFlights((current) => {
      const saved = writeTrackedFlights(flightSubject, updater(current))
      flightsRef.current = saved
      return saved
    })
  }, [flightSubject])

  // Abort every request owned by this account-scoped body before it can write
  // into a replacement family's state after unmount.
  useEffect(() => {
    bodyActiveRef.current = true
    const automaticRequests = automaticRequestRefs.current
    return () => {
      bodyActiveRef.current = false
      familyFetchGenerationRef.current += 1
      // Network helpers accept AbortSignals, so ownership stays with this
      // mounted body. Notification setup is not abortable; that path observes
      // bodyActiveRef and explicitly revokes any schedule completed too late.
      addRequestRef.current?.abort()
      refreshRequestRef.current?.abort()
      deleteRequestRef.current?.abort()
      for (const controller of automaticRequests) controller.abort()
      automaticRequests.clear()
    }
  }, [])

  // Initial and Realtime hydration share generation checks so only the newest
  // server snapshot can merge over the device cache.
  useEffect(() => {
    let active = true
    let unsubscribe: () => void = () => undefined
    /** Merges the latest family rows without overwriting newer local mutations. */
    async function refreshFamily() {
      // Realtime callbacks and initial hydration may overlap. A generation
      // identifies the newest fetch, while the mutation revision prevents an
      // older empty server response from erasing a create/delete that the user
      // just completed and persisted locally.
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
        const current = flightsRef.current
        const sharedIds = new Set(shared.map((flight) => flight.id))
        for (const removed of current) {
          if (
            removed.synced
            && !sharedIds.has(removed.id)
            && removed.notificationEnabled
          ) void cancelFlightNotifications(removed.id, flightSubject)
        }
        const merged = mergeTrackedFlights(current, shared)
        // Family data wins for synced records, but local-only demo/offline
        // cards survive the merge. Persisting the exact merged array keeps
        // the next cold launch consistent with the screen the user saw. Keep
        // notification side effects outside a React updater because StrictMode
        // may invoke an updater more than once to check that it is pure.
        writeTrackedFlights(flightSubject, merged)
        flightsRef.current = merged
        setFlights(merged)
        for (const updated of merged) {
          const previous = current.find((flight) => flight.id === updated.id)
          if (
            previous?.notificationEnabled
            && previous.snapshot.updatedAt !== updated.snapshot.updatedAt
          ) {
            void rescheduleFlightNotifications(updated, flightSubject).then(async (enabled) => {
              const latest = flightsRef.current.find((flight) =>
                flight.id === updated.id,
              )
              // Revocation can finish while this non-abortable native call is
              // open. Remove a late schedule if the subject disappeared, the
              // row was deleted, or this device's alert preference is now off.
              if (!active || !latest?.notificationEnabled) {
                if (enabled) {
                  await cancelFlightNotifications(updated.id, flightSubject)
                }
                return
              }
              if (!enabled) {
                updateFlights((latest) => latest.map((flight) =>
                  flight.id === updated.id
                    ? { ...flight, notificationEnabled: false }
                    : flight,
                ))
              }
            })
          }
        }
      } catch {
        // Account-scoped local flights remain usable while offline.
      }
    }

    void refreshFamily()
    const stopResume = subscribeToAppResume(() => void refreshFamily())
    void subscribeToFamilyFlights(() => void refreshFamily())
      .then((stop) => {
        if (active) unsubscribe = stop
        else stop()
      })
      .catch(() => undefined)

    return () => {
      active = false
      stopResume()
      unsubscribe()
    }
  }, [flightSubject, updateFlights])

  // Production clocks tick once a minute and immediately on browser/native
  // resume; supplied test clocks remain fixed and install no listeners.
  useEffect(() => {
    if (suppliedNow) return
    /** Advances time-dependent progress and scheduling labels. */
    const tick = () => {
      setClock(new Date())
    }
    const timer = window.setInterval(tick, 60_000)
    /** Refreshes immediately after a backgrounded browser becomes visible. */
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

  // Cancel alerts as soon as any server refresh marks a flight terminal.
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

  // The add-flight sheet owns focus, scroll locking, Escape, Android Back, and
  // keyboard containment for its entire modal lifecycle.
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
    /** Routes native and keyboard dismissal through request cancellation. */
    function closeModal() {
      closeAddFlight()
    }
    /** Handles Escape and keeps Tab focus within the modal sheet. */
    function handleModalKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        // Treat Escape like the visible Close control and stop it propagating
        // to page-level shortcuts beneath this modal sheet.
        event.preventDefault()
        event.stopPropagation()
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

  // Launch only the candidates reserved by the persistent provider budget;
  // each controller is retained until its request settles or the body unmounts.
  useEffect(() => {
    // Automatic refresh is deliberately budgeted before requests are launched
    // (see flightAutomaticRefresh). The controllers still belong here so a
    // subject change or unmount cannot apply a response to another family.
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
          const latestAfterSchedule = flightsRef.current.find((item) =>
            item.id === flight.id,
          )
          // A user may turn alerts off while an automatic refresh is awaiting
          // the native scheduler. Revoke a schedule that completed after that
          // preference change instead of silently turning alerts back on.
          if (
            current.notificationEnabled
            && notificationsRemainEnabled
            && (!latestAfterSchedule || !latestAfterSchedule.notificationEnabled)
          ) {
            await cancelFlightNotifications(flight.id, flightSubject)
          }
          updateFlights((latest) => latest.map((item) => item.id === flight.id
              ? {
                  ...item,
                  snapshot,
                  synced: true,
                  notificationEnabled: current.notificationEnabled
                    ? item.notificationEnabled && notificationsRemainEnabled
                    : item.notificationEnabled,
                }
              : item,
            ))
        })
        .catch(() => undefined)
        .finally(() => automaticRequestRefs.current.delete(controller))
    }
  }, [flightSubject, flights, now, updateFlights])

  /** Runs one idempotent create/choice request and rejects stale completions. */
  async function requestFlightCreate(
    identity: FlightCreateIdentity,
    id: string,
    providerFlightId?: string,
  ) {
    // React state does not update synchronously. This ref is the same-tick
    // latch that makes a double submit/choice tap a single idempotent request.
    if (addRequestRef.current) return
    const controller = new AbortController()
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
        // Ambiguous codeshares remain tied to the original normalized form and
        // pending ID. Choosing a provider result therefore continues the same
        // logical create instead of creating a second family row.
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
        // Realtime hydration can arrive before this response. Upsert by the
        // client-generated ID and retain any alert preference already merged
        // from that authoritative family record.
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
        // Only definitive input failures discard the pending ID. Connectivity
        // and server failures are uncertain, so retrying must reuse the ID to
        // avoid duplicate rows if the first request actually committed.
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

  /** Validates the sheet and reserves a durable create ID before networking. */
  async function addFlight(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pendingFlightChoices || addRequestRef.current) return
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
    // Persist the client ID before crossing the network. This is the durable
    // idempotency key used again after an ambiguous timeout or app restart.
    const id = getOrCreatePendingFlightCreateId(
      flightSubject,
      identity,
      createTrackedFlightId,
    )
    await requestFlightCreate(identity, id)
  }

  /** Continues an ambiguous lookup with the original identity and create ID. */
  async function chooseFlight(choice: FlightLookupChoice) {
    if (!pendingFlightChoices || saving) return
    setFormError(null)
    await requestFlightCreate(
      pendingFlightChoices.identity,
      pendingFlightChoices.id,
      choice.providerFlightId,
    )
  }

  /** Refreshes one card and replaces its device alerts with the new ETA. */
  async function refreshFlight(flight: TrackedFlight) {
    // One user-driven flight mutation at a time keeps refresh, deletion, and
    // alert rescheduling from racing to write different notificationEnabled
    // values for the same cached card. Refs cover taps before disabled state
    // has rendered.
    if (
      refreshRequestRef.current
      || deleteRequestRef.current
      || notificationRequestRef.current
    ) return
    const controller = new AbortController()
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

  /** Owns explicit alert consent and revokes schedules that finish after unmount. */
  async function toggleNotifications(flight: TrackedFlight) {
    if (
      notificationRequestRef.current
      || refreshRequestRef.current
      || deleteRequestRef.current
    ) return
    notificationRequestRef.current = flight.id
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
      // Permission is requested only from this explicit button gesture. If the
      // screen/subject disappeared while the OS prompt was open, immediately
      // revoke a late successful schedule so it cannot leak to the next user.
      if (!bodyActiveRef.current) {
        if (result.enabled) {
          await cancelFlightNotifications(flight.id, flightSubject)
        }
        return
      }
      const latest = flightsRef.current.find((item) => item.id === flight.id)
      if (
        result.enabled
        && (!latest || isFlightCancelled(latest.snapshot))
      ) {
        await cancelFlightNotifications(flight.id, flightSubject)
        if (latest) {
          setStatusMessage('Alerts stay off because this flight was cancelled.')
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
      if (notificationRequestRef.current === flight.id) {
        notificationRequestRef.current = null
        if (bodyActiveRef.current) setNotificationPendingId(null)
      }
    }
  }

  /** Opens a clean lookup sheet and remembers the invoking control. */
  function openAddFlight() {
    returnFocusRef.current = document.activeElement as HTMLElement | null
    setPendingFlightChoices(null)
    setFormError(null)
    setStatusMessage('')
    setShowAddFlight(true)
  }

  /** Aborts any lookup, resets ambiguity state, and restores prior focus. */
  function closeAddFlight() {
    // Close, Escape, and native Back all intentionally own cancellation of the
    // modal request. A late response is also rejected by controller identity.
    addRequestRef.current?.abort()
    addRequestRef.current = null
    setSaving(false)
    setPendingFlightChoices(null)
    setShowAddFlight(false)
    window.requestAnimationFrame(() => returnFocusRef.current?.focus())
  }

  /** Expands one flight card while clearing any previous deletion prompt. */
  function toggleFlightActions(flightId: string) {
    if (deleteRequestRef.current) return
    setStatusMessage('')
    setConfirmDeleteId(null)
    setExpandedFlightId((current) => current === flightId ? null : flightId)
  }

  /** Deletes an authorized shared row before removing its local card and alerts. */
  async function stopTracking(flight: TrackedFlight) {
    if (
      deleteRequestRef.current
      || refreshRequestRef.current
      || notificationRequestRef.current
    ) return
    const controller = new AbortController()
    deleteRequestRef.current = controller
    setDeletingId(flight.id)
    setStatusMessage('')
    try {
      if (flight.synced) {
        // Do not optimistically remove shared cards: the server enforces owner
        // permissions. Keeping the local card until acknowledgement also makes
        // offline and authorization failures recoverable without data loss.
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

  /** Opens confirmation only when no conflicting flight mutation owns the UI. */
  function openDeleteConfirmation(flightId: string) {
    if (
      deleteRequestRef.current
      || refreshRequestRef.current
      || notificationRequestRef.current
    ) return
    setStatusMessage('')
    setExpandedFlightId(flightId)
    setConfirmDeleteId(flightId)
  }

  /** Retains the synchronous deletion latch behind the controlled Keep action. */
  function keepFlight() {
    if (deleteRequestRef.current) return
    setConfirmDeleteId(null)
  }

  const ticketActivity = { notificationPendingId, refreshingId, deletingId }
  const ticketActions = {
    toggleNotifications,
    refreshFlight,
    openDeleteConfirmation,
    keepFlight,
    stopTracking,
    toggleFlightActions,
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
        <div className="flight-empty-journey">
          {/* The route is decoration only. Keeping it out of the accessibility
              tree lets the short empty-state copy remain the useful message. */}
          <div className="flight-empty-journey__route" aria-hidden="true">
            <span className="flight-empty-journey__stop" />
            <span className="flight-empty-journey__plane"><PlaneIcon /></span>
            <span className="flight-empty-journey__stop" />
          </div>
          <h3>No journeys on the board yet</h3>
          <p>When travel is booked, add the flight so everyone can follow along.</p>
          <button type="button" onClick={openAddFlight}>Track a flight</button>
        </div>
      ) : (
        <ul className="flight-list">
          {flights.map((flight) => (
            <li className="flight-list__featured" key={flight.id}>
              <FlightTicket
                flight={flight}
                now={now}
                expanded={expandedFlightId === flight.id}
                confirmingDelete={confirmDeleteId === flight.id}
                activity={ticketActivity}
                actions={ticketActions}
              />
            </li>
          ))}
        </ul>
      )}

      {statusMessage ? <p className="flight-tracker__status" role="status">{statusMessage}</p> : null}

      {showAddFlight ? createPortal(
        <FlightLookupSheet
          now={now}
          formDescriptionId={formDescriptionId}
          formErrorId={formErrorId}
          addCloseRef={addCloseRef}
          saving={saving}
          choices={pendingFlightChoices?.choices ?? null}
          formError={formError}
          addFlight={addFlight}
          closeAddFlight={closeAddFlight}
          chooseFlight={chooseFlight}
          onChangeSearch={() => setPendingFlightChoices(null)}
        />,
        portalTarget,
      ) : null}
    </section>
  )
}
