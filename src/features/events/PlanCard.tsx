import type { FormEvent, RefObject } from 'react'
import type { FamilyEvent } from './familyPlanTypes'
import type { PlanDoodleName, PlanTask } from './planDetails'
import { planCategoryLabel, planDoodleForSeed } from './planViewModel'

type PlanCardProps = {
  event: FamilyEvent
  revealed: boolean
  checklist: PlanTask[]
  completedChecklistItems: ReadonlySet<string>
  reminder: { enabled: boolean; busy: boolean }
  completionBusy: boolean
  composerInputRef: RefObject<HTMLInputElement | null>
  composer: {
    open: boolean
    value: string
    onValueChange: (value: string) => void
    onToggle: () => void
    onCancel: () => void
    onSubmit: (event: FormEvent<HTMLFormElement>) => void
  }
  onToggleReminder: () => void
  onToggleTask: (task: PlanTask) => void
  onComplete: () => void
}

/** Displays one controlled plan without owning persistence, reminders or shared mutations. */
export function PlanCard({
  event,
  revealed,
  checklist,
  completedChecklistItems,
  reminder,
  completionBusy,
  composerInputRef,
  composer,
  onToggleReminder,
  onToggleTask,
  onComplete,
}: PlanCardProps) {
  const date = new Date(`${event.date}T12:00:00`)
  const day = new Intl.DateTimeFormat('en', {
    day: '2-digit',
  }).format(date)
  const month = new Intl.DateTimeFormat('en', {
    month: 'short',
  }).format(date)
  const time = new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(event.startsAt))
  const weekday = new Intl.DateTimeFormat('en', {
    weekday: 'long',
  }).format(date)
  const hasReminder = reminder.enabled
  const categoryLabel = planCategoryLabel(event.category)
  const presentation = event.demoPresentation
  const doodle = event.doodle
    ?? presentation?.doodle
    ?? planDoodleForSeed(event.id)

  return (
    <article
      key={event.id}
      className={`ks-card event-list-item event-plan-card${
        revealed ? ' journal-events__event--revealed' : ''
      }`}
      data-category={event.category}
    >
      <div className="event-plan-card__artwork" aria-hidden="true">
        <span className="event-plan-card__sketch">
          <PlanDoodle doodle={doodle} />
        </span>
        <time
          className="event-plan-card__date journal-events__sr-only"
          dateTime={event.date}
          aria-label={`${weekday}, ${month} ${day}`}
        >
          <strong>{day}</strong>
          <span>{month}</span>
        </time>
      </div>
      <div className="event-plan-card__content">
        <div className="event-plan-card__title-row">
          <div>
            <span className="event-list-item__category journal-events__sr-only">
              {categoryLabel}
            </span>
            <h4>{event.title}</h4>
          </div>
          <button
            className="event-reminder-button event-plan-card__doodle"
            type="button"
            aria-label={`${
              hasReminder ? 'Remove reminder for' : 'Remind me about'
            } ${event.title}`}
            aria-pressed={hasReminder}
            aria-busy={reminder.busy}
            disabled={reminder.busy}
            onClick={onToggleReminder}
          >
            <ReminderBellDoodle />
            <span className="journal-events__sr-only">
              {hasReminder ? 'Reminder on' : 'Remind me'}
            </span>
          </button>
        </div>
        <p className="event-plan-card__when">
          <time dateTime={event.startsAt}>
            {presentation?.timeStyle === 'time-location'
              ? time
              : presentation?.timeStyle === 'next-weekend'
                ? 'Next weekend'
                : `${weekday} · ${time}`}
          </time>
          {presentation?.timeStyle === 'time-location' ? (
            <span> · {event.location}</span>
          ) : null}
        </p>
        {!presentation ? (
          <p className="event-plan-card__location">{event.location}</p>
        ) : null}
        {presentation ? (
          <div
            className="event-plan-card__attendees"
            aria-label={`Going: ${presentation.attendees
              .map((attendee) => attendee.name)
              .join(', ')}${presentation.additionalAttendees > 0
              ? `, plus ${presentation.additionalAttendees} more`
              : ''}`}
          >
            {presentation.attendees.map((attendee) => (
              <span key={attendee.name} title={attendee.name}>
                {attendee.initials}
              </span>
            ))}
            {presentation.additionalAttendees > 0 ? (
              <span aria-hidden="true">
                +{presentation.additionalAttendees}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {checklist.length > 0 ? (
        <ul
          className="event-plan-card__checklist"
          aria-label={`${event.title} checklist`}
        >
          {checklist.map((item) => {
            const checked = completedChecklistItems.has(item.id)
            return (
              <li key={item.id}>
                <label data-checked={checked ? 'true' : 'false'}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleTask(item)}
                  />
                  <span className="event-plan-card__checkbox" aria-hidden="true">
                    <svg viewBox="0 0 16 16">
                      <path d="m3 8 3 3 7-8" />
                    </svg>
                  </span>
                  <span>{item.label}</span>
                </label>
              </li>
            )
          })}
        </ul>
      ) : null}
      {composer.open ? (
        <form
          className="event-plan-card__task-composer"
          aria-label={`Add task to ${event.title}`}
          onSubmit={composer.onSubmit}
        >
          <label htmlFor={`plan-task-${event.id}`}>New task</label>
          <div>
            <input
              ref={composerInputRef}
              id={`plan-task-${event.id}`}
              value={composer.value}
              maxLength={80}
              placeholder="Bring dessert"
              enterKeyHint="done"
              onChange={(changeEvent) => composer.onValueChange(changeEvent.target.value)}
              onKeyDown={(keyEvent) => {
                if (keyEvent.key === 'Escape') {
                  composer.onCancel()
                }
              }}
            />
            <button type="submit">Save</button>
          </div>
        </form>
      ) : null}
      <div className="event-plan-card__actions">
        <button
          className="event-plan-card__add-task"
          type="button"
          aria-expanded={composer.open}
          onClick={composer.onToggle}
        >
          <span aria-hidden="true">＋</span>
          <span>{composer.open ? 'Cancel' : 'Add task'}</span>
          <span className="journal-action-spacer" aria-hidden="true" />
        </button>
        <button
          className="event-plan-card__complete"
          type="button"
          aria-label={`Complete task: ${event.title}`}
          aria-busy={completionBusy}
          disabled={completionBusy}
          onClick={onComplete}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20">
            <path d="m4 10 4 4 8-9" />
          </svg>
          <span>Complete task</span>
          <span className="journal-action-spacer" aria-hidden="true" />
        </button>
      </div>
    </article>
  )
}

/** Renders one decorative plan motif outside the accessibility tree. */
function PlanDoodle({ doodle }: { doodle: PlanDoodleName }) {
  if (doodle === 'heart') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 27S5 21 5 12.8C5 8.2 10.6 6 16 12c5.4-6 11-3.8 11 1 0 8-11 14-11 14Z" />
      </svg>
    )
  }
  if (doodle === 'star') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="m16 3.5 3.7 8 8.7 1-6.5 5.8 1.8 8.5-7.7-4.5-7.7 4.5 1.8-8.5-6.5-5.8 8.7-1Z" />
        <path d="m16 8 1.9 5.8 6 .1-4.8 3.5 1.7 5.8-4.8-3.5-4.8 3.5 1.7-5.8-4.8-3.5 6-.1Z" />
      </svg>
    )
  }
  if (doodle === 'sun') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="6" />
        <path d="M16 2v5m0 18v5M2 16h5m18 0h5M6.1 6.1l3.6 3.6m12.6 12.6 3.6 3.6m0-19.8-3.6 3.6M9.7 22.3l-3.6 3.6" />
      </svg>
    )
  }
  if (doodle === 'fish') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M5 16c4.2-6.3 11.7-8.4 18-3.2l5-3v12.4l-5-3C16.7 24.4 9.2 22.3 5 16Z" />
        <circle cx="20" cy="14.3" r="0.8" />
        <path d="M10 12.5c1.8 2.1 1.8 4.9 0 7m4.5-9.1 2.2-3.2 2.1 3.9" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 27S5 21 5 12.8C5 8.2 10.6 6 16 12c5.4-6 11-3.8 11 1 0 8-11 14-11 14Z" />
    </svg>
  )
}

/** Renders the shared reminder-control glyph. */
function ReminderBellDoodle() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M9 22h14l-2-3.2V14a5 5 0 0 0-10 0v4.8Zm5 3h4" />
      <path d="M8 8.5c-1.5 1.4-2.2 3.2-2.2 5.2m18.4-5.2c1.5 1.4 2.2 3.2 2.2 5.2" />
    </svg>
  )
}
