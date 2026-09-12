import type { FamilyEvent } from './familyPlanTypes'
import { formatPlanWeekRange, localDateInputValue, planWeekForDate, shiftPlanDay } from './planViewModel'

type PlanWeekPickerProps = {
  selectedPlanDay: string
  events: readonly FamilyEvent[]
  onChoosePlanDay: (date: string) => void
}

/** Controlled local-week navigation; the parent owns selection and list expansion. */
export function PlanWeekPicker({ selectedPlanDay, events, onChoosePlanDay }: PlanWeekPickerProps) {
  const displayedWeek = planWeekForDate(selectedPlanDay)
  const displayedWeekRange = formatPlanWeekRange(displayedWeek)

  return (
    <nav
      className="journal-events__week"
      aria-label={`Family plans, ${displayedWeekRange}`}
    >
      <div className="journal-events__week-days">
        {displayedWeek.map((date) => {
          const dateValue = localDateInputValue(date)
          const selected = dateValue === selectedPlanDay
          const hasPlans = events.some(
            (event) => event.date === dateValue,
          )
          const weekday = new Intl.DateTimeFormat('en', {
            weekday: 'long',
          }).format(date)
          return (
            <button
              key={dateValue}
              type="button"
              aria-label={`${weekday}, ${new Intl.DateTimeFormat('en', {
                month: 'long',
                day: 'numeric',
              }).format(date)}${hasPlans ? ', has plans' : ''}`}
              aria-pressed={selected}
              data-has-plans={hasPlans ? 'true' : 'false'}
              onClick={() => onChoosePlanDay(dateValue)}
            >
              <span aria-hidden="true">{weekday.slice(0, 1)}</span>
              <strong>{date.getDate()}</strong>
              <i aria-hidden="true" />
            </button>
          )
        })}
      </div>
      <div className="journal-events__week-navigation">
        <button
          type="button"
          aria-label="Previous week"
          onClick={() => onChoosePlanDay(shiftPlanDay(selectedPlanDay, -7))}
        >
          <svg aria-hidden="true" viewBox="0 0 12 12">
            <path d="m7.5 2-4 4 4 4" />
          </svg>
        </button>
        <p aria-live="polite">{displayedWeekRange}</p>
        <button
          type="button"
          aria-label="Next week"
          onClick={() => onChoosePlanDay(shiftPlanDay(selectedPlanDay, 7))}
        >
          <svg aria-hidden="true" viewBox="0 0 12 12">
            <path d="m4.5 2 4 4-4 4" />
          </svg>
        </button>
      </div>
    </nav>
  )
}
