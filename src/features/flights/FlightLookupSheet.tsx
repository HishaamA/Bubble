import type { FormEvent, Ref } from 'react'
import type { FlightLookupChoice } from './flightStatusService'
import { shiftLocalCalendarDate, type FlightFormValidation } from './flightValidation'
import { formatChoiceDeparture } from './flightPresentation'
import { FlightRouteMark } from './FlightArtwork'

export type FlightLookupFormError = {
  field: Extract<FlightFormValidation, { valid: false }>['field'] | null
  message: string
}

type FlightLookupSheetProps = {
  now: Date
  formDescriptionId: string
  formErrorId: string
  addCloseRef: Ref<HTMLButtonElement>
  saving: boolean
  choices: readonly FlightLookupChoice[] | null
  formError: FlightLookupFormError | null
  addFlight: (event: FormEvent<HTMLFormElement>) => Promise<void>
  closeAddFlight: () => void
  chooseFlight: (choice: FlightLookupChoice) => Promise<void>
  onChangeSearch: () => void
}

/** Controlled form; its parent owns portal placement, focus, dismissal, and requests. */
export function FlightLookupSheet({
  now,
  formDescriptionId,
  formErrorId,
  addCloseRef,
  saving,
  choices,
  formError,
  addFlight,
  closeAddFlight,
  chooseFlight,
  onChangeSearch,
}: FlightLookupSheetProps) {
  return (
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
            disabled={saving || choices !== null}
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
            disabled={saving || choices !== null}
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
            disabled={saving || choices !== null}
            aria-invalid={formError?.field === 'travelDate'}
            aria-describedby={formError?.field === 'travelDate' ? formErrorId : undefined}
            required
          />
          <small>Choose the calendar date where the flight leaves, in the departure airport’s local time.</small>
        </label>
        {choices ? (
          <section className="flight-choice" aria-labelledby="flight-choice-title">
            <div className="flight-choice__header">
              <div>
                <p>Double-check the departure</p>
                <h3 id="flight-choice-title">
                  We found {choices.length} flights that day
                </h3>
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={onChangeSearch}
              >
                Change search
              </button>
            </div>
            <div className="flight-choice__list">
              {choices.map((choice) => (
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
        {!choices ? (
          <button className="flight-sheet__submit" type="submit" disabled={saving}>
            {saving ? 'Finding flight…' : 'Track flight'}
          </button>
        ) : null}
      </form>
    </div>
  )
}
