const WEEK_LENGTH_DAYS = 7

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

export function startOfCapsuleWeek(value: Date) {
  const day = startOfLocalDay(value)
  const daysSinceMonday = (day.getDay() + 6) % WEEK_LENGTH_DAYS
  day.setDate(day.getDate() - daysSinceMonday)
  return day
}

export function addLocalDays(value: Date, days: number) {
  const next = new Date(value)
  next.setDate(next.getDate() + days)
  return next
}

export function toLocalDateInput(value: Date) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getWeeklyCapsuleWindow(value: Date) {
  const weekStart = startOfCapsuleWeek(value)
  const opensAt = addLocalDays(weekStart, WEEK_LENGTH_DAYS)
  return {
    weekStart,
    closesAt: opensAt,
    opensAt,
  }
}

export function isCapsuleUnlocked(opensAt: string, now: Date) {
  return new Date(opensAt).getTime() <= now.getTime()
}

export function formatCapsuleCountdown(opensAt: string, now: Date) {
  const difference = new Date(opensAt).getTime() - now.getTime()
  if (difference <= 0) return 'Ready to watch'

  const hours = Math.ceil(difference / 3_600_000)
  if (hours < 24) return `Unlocks in ${hours} ${hours === 1 ? 'hour' : 'hours'}`

  const days = Math.ceil(hours / 24)
  return `Unlocks in ${days} ${days === 1 ? 'day' : 'days'}`
}
