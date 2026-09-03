/** Formats a date component for local ISO-style keys. */
function padDatePart(value: number) {
  return String(value).padStart(2, '0')
}

/** Returns midnight for the supplied date in the device's local timezone. */
export function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** Adds calendar days without assuming that every day contains 24 hours. */
export function addLocalDays(date: Date, days: number) {
  const result = startOfLocalDay(date)
  result.setDate(result.getDate() + days)
  return result
}

/** Produces a stable YYYY-MM-DD key in the device's local timezone. */
export function toLocalIsoDate(date: Date) {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join('-')
}

/** Produces the long English date label used by accessible controls. */
export function formatLocalDay(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

/** Compares calendar days while ignoring their time of day. */
export function isAfterLocalDay(date: Date, today: Date) {
  return toLocalIsoDate(date) > toLocalIsoDate(today)
}
