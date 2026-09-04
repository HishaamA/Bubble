const WEEK_LENGTH_DAYS = 7

/** Removes the local time component without crossing a UTC date boundary. */
function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

/** Returns the local Monday that owns the supplied date. */
export function startOfCapsuleWeek(value: Date) {
  const day = startOfLocalDay(value)
  const daysSinceMonday = (day.getDay() + 6) % WEEK_LENGTH_DAYS
  day.setDate(day.getDate() - daysSinceMonday)
  return day
}

/** Adds calendar days without converting through UTC or losing local DST rules. */
export function addLocalDays(value: Date, days: number) {
  const next = new Date(value)
  next.setDate(next.getDate() + days)
  return next
}

/** Formats a local date for native date inputs and family API fields. */
export function toLocalDateInput(value: Date) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Defines the Monday-to-Monday collection and reveal window for one week. */
export function getWeeklyCapsuleWindow(value: Date) {
  const weekStart = startOfCapsuleWeek(value)
  const opensAt = addLocalDays(weekStart, WEEK_LENGTH_DAYS)
  return {
    weekStart,
    closesAt: opensAt,
    opensAt,
  }
}

/** Reports whether a Capsule's reveal instant has passed. */
export function isCapsuleUnlocked(opensAt: string, now: Date) {
  return new Date(opensAt).getTime() <= now.getTime()
}

/** Formats a coarse countdown without implying greater scheduling precision. */
export function formatCapsuleCountdown(opensAt: string, now: Date) {
  const difference = new Date(opensAt).getTime() - now.getTime()
  if (difference <= 0) return 'Ready to watch'

  const hours = Math.ceil(difference / 3_600_000)
  if (hours < 24) return `Unlocks in ${hours} ${hours === 1 ? 'hour' : 'hours'}`

  const days = Math.ceil(hours / 24)
  return `Unlocks in ${days} ${days === 1 ? 'day' : 'days'}`
}
