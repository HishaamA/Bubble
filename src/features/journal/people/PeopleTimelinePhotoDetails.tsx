import type { FormEventHandler } from 'react'
import type {
  TimelineDateOverride,
  TimelineDatePrecision,
  TimelinePerson,
  TimelinePhotoAssignment,
} from './types'

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
            <p>Add a person with a face photo above, then review or correct matches here.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}
