import type { FormEventHandler, Ref } from 'react'

type PeopleTimelinePersonFormProps = {
  formRef: Ref<HTMLFormElement>
  name: string
  disabled: boolean
  scanning: boolean
  error: string
  onNameChange: (name: string) => void
  onPortraitsChange: (files: File[]) => void
  onSubmit: FormEventHandler<HTMLFormElement>
  onCancel: () => void
}

/** Keeps transient file selection controlled by the timeline's enrollment flow. */
export function PeopleTimelinePersonForm({
  formRef,
  name,
  disabled,
  scanning,
  error,
  onNameChange,
  onPortraitsChange,
  onSubmit,
  onCancel,
}: PeopleTimelinePersonFormProps) {
  return (
    <form
      ref={formRef}
      className="people-timeline__inline-form people-timeline__person-form"
      aria-label="Add a person"
      onSubmit={onSubmit}
    >
      <label>
        <span>Name</span>
        <input
          autoFocus
          value={name}
          maxLength={40}
          autoComplete="off"
          autoCapitalize="words"
          autoCorrect="off"
          disabled={disabled}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      <label>
        <span>Face photos</span>
        <input
          type="file"
          accept="image/*"
          multiple
          disabled={disabled}
          onChange={(event) => onPortraitsChange(Array.from(event.currentTarget.files ?? []))}
        />
        <small>Choose 1–5 clear solo photos. Different ages or slight angles improve matching. The photos are scanned once and never stored.</small>
      </label>
      <div className="people-timeline__form-actions">
        <button type="submit" disabled={disabled}>
          {scanning ? 'Scanning…' : 'Add person'}
        </button>
        <button type="button" disabled={scanning} onClick={onCancel}>Cancel</button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  )
}

type PeopleTimelinePersonManagerProps = {
  personName: string
  name: string
  referenceCount: number
  selectedPortraitCount: number
  scanning: boolean
  referenceDisabled: boolean
  error: string
  confirmingDelete: boolean
  onNameChange: (name: string) => void
  onPortraitsChange: (files: File[]) => void
  onRename: FormEventHandler<HTMLFormElement>
  onSavePortraits: FormEventHandler<HTMLFormElement>
  onDelete: () => void
  onConfirmDelete: (confirming: boolean) => void
  onDone: () => void
}

/** Presentation only: async scans, validation, and deletion stay in the owner. */
export function PeopleTimelinePersonManager({
  personName,
  name,
  referenceCount,
  selectedPortraitCount,
  scanning,
  referenceDisabled,
  error,
  confirmingDelete,
  onNameChange,
  onPortraitsChange,
  onRename,
  onSavePortraits,
  onDelete,
  onConfirmDelete,
  onDone,
}: PeopleTimelinePersonManagerProps) {
  return (
    <section className="people-timeline__manage-panel" aria-label={`Manage ${personName}`}>
      <header className="people-timeline__manage-header">
        <div>
          <span>Person details</span>
          <h3>Manage {personName}</h3>
        </div>
        <button type="button" className="people-timeline__manage-done" onClick={onDone}>
          Done
        </button>
      </header>
      <form
        className="people-timeline__inline-form people-timeline__rename-form"
        aria-label={`Rename ${personName}`}
        onSubmit={onRename}
      >
        <label>
          <span>Name</span>
          <input
            autoFocus
            value={name}
            maxLength={40}
            autoCapitalize="words"
            autoCorrect="off"
            enterKeyHint="done"
            disabled={scanning}
            onChange={(event) => onNameChange(event.target.value)}
          />
        </label>
        <div className="people-timeline__form-actions">
          <button type="submit" disabled={scanning}>Save name</button>
        </div>
      </form>
      <form
        className="people-timeline__reference-form"
        aria-label={`Add face photos for ${personName}`}
        onSubmit={onSavePortraits}
      >
        <div className="people-timeline__reference-copy">
          <strong>
            {referenceCount
              ? `${referenceCount} face ${referenceCount === 1 ? 'view' : 'views'} ready`
              : 'Face photo needed'}
          </strong>
          <span>
            {referenceCount
              ? 'Add a different age or angle to improve difficult matches.'
              : `Add one clear portrait to organize ${personName}’s photos automatically.`}
          </span>
        </div>
        <div className="people-timeline__reference-controls">
          <label
            className="people-timeline__face-picker"
            data-disabled={referenceDisabled ? 'true' : 'false'}
          >
            <input
              className="people-timeline__sr-only"
              type="file"
              accept="image/*"
              multiple
              aria-label={`Face photo for ${personName}`}
              disabled={referenceDisabled}
              onChange={(event) => onPortraitsChange(Array.from(event.currentTarget.files ?? []))}
            />
            <span className="people-timeline__face-picker-action" aria-hidden="true">
              Choose photos
            </span>
            <span className="people-timeline__face-picker-summary" aria-live="polite">
              {selectedPortraitCount
                ? `${selectedPortraitCount} ${selectedPortraitCount === 1 ? 'photo' : 'photos'} selected`
                : 'Up to 5 photos'}
            </span>
          </label>
          <button type="submit" disabled={referenceDisabled || !selectedPortraitCount}>
            {scanning ? 'Scanning…' : referenceCount ? 'Add face views' : 'Add face photo'}
          </button>
        </div>
      </form>
      {error ? <p className="people-timeline__manage-error" role="alert">{error}</p> : null}
      {confirmingDelete ? (
        <div className="people-timeline__delete-confirm" role="group" aria-label={`Remove ${personName}`}>
          <p>Remove this person and their photo tags?</p>
          <button type="button" onClick={onDelete}>Remove</button>
          <button type="button" onClick={() => onConfirmDelete(false)}>Keep</button>
        </div>
      ) : (
        <button
          type="button"
          className="people-timeline__delete-button"
          disabled={scanning}
          onClick={() => onConfirmDelete(true)}
        >
          Remove person
        </button>
      )}
    </section>
  )
}
