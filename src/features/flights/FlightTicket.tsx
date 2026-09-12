import type { CSSProperties } from 'react'
import type { FlightStatusSnapshot, TrackedFlight } from './types'
import {
  calculateFlightProgress,
  flightArrivalTime,
  flightDepartureTime,
  formatFlightDateTime,
  isFlightCancelled,
} from './flightValidation'
import {
  airportPlace,
  createFlightRoutePresentation,
  createFlightTicketPresentation,
  formatDayMonth,
  formatTicketTime,
  formatUpdatedAt,
  qualityLabel,
} from './flightPresentation'
import { BellIcon, CloseIcon, FlightRouteMark, PlaneIcon, RefreshIcon } from './FlightArtwork'

type FlightTicketProps = {
  flight: TrackedFlight
  now: Date
  expanded: boolean
  confirmingDelete: boolean
  activity: {
    notificationPendingId: string | null
    refreshingId: string | null
    deletingId: string | null
  }
  actions: {
    toggleNotifications: (flight: TrackedFlight) => Promise<void>
    refreshFlight: (flight: TrackedFlight) => Promise<void>
    openDeleteConfirmation: (flightId: string) => void
    keepFlight: () => void
    stopTracking: (flight: TrackedFlight) => Promise<void>
    toggleFlightActions: (flightId: string) => void
  }
}

/** Presents bounded journey progress or an explicit cancelled state. */
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

/** Draws a wrapped world route with a live or time-derived aircraft marker. */
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
  const { start, end, control, marker, markerDescription, rotation, shifts } =
    createFlightRoutePresentation(snapshot, now)

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

/** Controlled ticket presentation; all mutation ownership stays with the tracker. */
export function FlightTicket({
  flight,
  now,
  expanded,
  confirmingDelete,
  activity,
  actions,
}: FlightTicketProps) {
  const { notificationPendingId, refreshingId, deletingId } = activity
  const {
    toggleNotifications,
    refreshFlight,
    openDeleteConfirmation,
    keepFlight,
    stopTracking,
    toggleFlightActions,
  } = actions
  const { departure, arrival, quality, cancelled, duration } =
    createFlightTicketPresentation(flight, now)

  /** Renders mutually exclusive alert, refresh, and removal controls. */
  function flightToolbar(flight: TrackedFlight, cancelled: boolean) {
    const changingAlerts = notificationPendingId === flight.id
    const refreshing = refreshingId === flight.id
    const userMutationPending = notificationPendingId !== null
      || refreshingId !== null
      || deletingId !== null
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
          disabled={userMutationPending || cancelled}
          onClick={() => void toggleNotifications(flight)}
        >
          <BellIcon />
        </button>
        <button
          type="button"
          className="flight-card__icon-action"
          aria-label={refreshing ? `Refreshing ${flight.flightNumber}` : `Refresh ${flight.flightNumber}`}
          disabled={userMutationPending}
          onClick={() => void refreshFlight(flight)}
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          className="flight-card__icon-action flight-card__icon-action--remove"
          aria-label={`Stop tracking ${flight.flightNumber}`}
          disabled={userMutationPending}
          onClick={() => openDeleteConfirmation(flight.id)}
        >
          <CloseIcon />
        </button>
      </div>
    )
  }

  /** Renders expanded route, time-zone, provider, and deletion details. */
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
        {confirmingDelete ? (
          <div className="flight-detail__delete-confirm" role="group" aria-label={`Confirm stop tracking ${flight.flightNumber}`}>
            <p>Stop sharing this flight with the family?</p>
            <div>
              <button
                type="button"
                disabled={deletingId === flight.id}
                onClick={keepFlight}
              >
                Keep flight
              </button>
              <button
                type="button"
                className="flight-detail__delete-confirm-action"
                disabled={
                  deletingId !== null
                  || refreshingId !== null
                  || notificationPendingId !== null
                }
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
    <article
      className="flight-card flight-card--featured"
      data-cancelled={cancelled ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
    >
      {flightToolbar(flight, cancelled)}
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
            <strong>{cancelled ? 'Not applicable' : formatTicketTime(arrival, flight.snapshot.destination.timeZone) ?? 'Not available'}</strong>
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
      <button
        type="button"
        className="flight-card__expand"
        aria-label={`${expanded ? 'Hide' : 'Show'} all info for ${flight.flightNumber}`}
        aria-expanded={expanded}
        aria-controls={`flight-details-${flight.id}`}
        disabled={deletingId === flight.id}
        onClick={() => toggleFlightActions(flight.id)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {expanded ? flightDetails(flight, quality, cancelled) : null}
    </article>
  )
}
