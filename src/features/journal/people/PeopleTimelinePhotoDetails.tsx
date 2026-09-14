import { useId, useState, type FormEventHandler } from 'react'
import './PhotoMatchCorrection.css'
import type {
  TimelineDateOverride,
  TimelineDatePrecision,
  TimelinePerson,
  TimelinePhotoAssignment,
} from './types'

/** Explicit label correction, never a photo-removal action. Key by photo/person. */
export function PhotoMatchCorrection({ personName, photoDescription, onCorrect }: {
  personName: string
  photoDescription: string
  onCorrect: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const descriptionId = useId()
  return (
    <div className="photo-match-correction">
      <button type="button" className="photo-match-correction__toggle"
        aria-expanded={confirming}
        aria-label={`Correct automatic match for ${personName} in ${photoDescription}`}
        onClick={() => setConfirming((value) => !value)}>
        Not {personName}?
      </button>
      {confirming ? (
        <div className="photo-match-correction__confirm" role="group"
          aria-label={`Remove automatic match for ${personName}?`} aria-describedby={descriptionId}>
          <p id={descriptionId}>Only this person label will be removed. Your photo stays in All photos and its original location.</p>
          <div>
            <button type="button" onClick={() => { onCorrect(); setConfirming(false) }}>Not {personName}</button>
            <button type="button" onClick={() => setConfirming(false)}>Keep match</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

type PeopleTimelineDateEditorProps = {
  draft: TimelineDateOverride
  error: string
  hasOverride: boolean
  onPrecisionChange: (precision: TimelineDatePrecision) => void
  onValueChange: (value: string) => void
  onSave: FormEventHandler<HTMLFormElement>
  onCancel: () => void
  onRestoreOriginal: () => void
}

/** Controlled date input; validation and durable corrections stay with the timeline. */
export function PeopleTimelineDateEditor({
  draft,
  error,
  hasOverride,
  onPrecisionChange,
  onValueChange,
  onSave,
  onCancel,
  onRestoreOriginal,
}: PeopleTimelineDateEditorProps) {
  return (
    <form className="people-timeline__date-editor" aria-label="Edit photo date" onSubmit={onSave}>
      <div className="people-timeline__date-kind" role="group" aria-label="Date detail">
        <button type="button" aria-pressed={draft.precision === 'year'} onClick={() => onPrecisionChange('year')}>Year</button>
        <button type="button" aria-pressed={draft.precision === 'day'} onClick={() => onPrecisionChange('day')}>Date</button>
      </div>
      <label>
        <span>{draft.precision === 'year' ? 'Approximate year' : 'Date'}</span>
        <input
          type={draft.precision === 'year' ? 'number' : 'date'}
          inputMode={draft.precision === 'year' ? 'numeric' : undefined}
          enterKeyHint="done"
          min={draft.precision === 'year' ? '1800' : '1800-01-01'}
          max={draft.precision === 'year' ? String(new Date().getFullYear() + 1) : undefined}
          value={draft.value}
          onChange={(event) => onValueChange(event.target.value)}
        />
      </label>
      <div className="people-timeline__form-actions">
        <button type="submit">Save date</button>
        <button type="button" onClick={onCancel}>Cancel</button>
        {hasOverride ? <button type="button" onClick={onRestoreOriginal}>Use original</button> : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  )
}

type PeopleTimelinePhotoTagsProps = {
  photoKey: string
  people: readonly TimelinePerson[]
  assignments: readonly TimelinePhotoAssignment[]
  effectivePersonIds?: ReadonlySet<string>
  open: boolean
  onToggle: () => void
  onTagChange: (personId: string, checked: boolean) => void
}

/** Presents manual and inferred tags without writing face profiles or assignments. */
export function PeopleTimelinePhotoTags({
  photoKey, people, assignments, effectivePersonIds, open, onToggle, onTagChange,
}: PeopleTimelinePhotoTagsProps) {
  return (
    <div className="people-timeline__tagging">
      <button
        type="button"
        className="people-timeline__tag-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        People in this photo
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <div className="people-timeline__tag-panel">
          {people.length ? people.map((person) => {
            const checked = effectivePersonIds?.has(person.id) ?? false
            const manuallyTagged = assignments.some((assignment) =>
              assignment.photoKey === photoKey &&
              assignment.personId === person.id &&
              assignment.source === 'manual',
            )
            return (
              <label key={person.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => onTagChange(person.id, event.target.checked)}
                />
                <span>
                  {person.name}
                  {checked
                    ? <small>{manuallyTagged ? 'Confirmed by you' : 'Matched automatically'}</small>
                    : null}
                </span>
              </label>
            )
          }) : (
            <p>Add a face photo for a person to match them automatically. You can also tag this photo yourself.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}
