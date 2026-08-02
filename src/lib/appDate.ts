function padDatePart(value: number) {
  return String(value).padStart(2, '0')
}

export function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function addLocalDays(date: Date, days: number) {
  const result = startOfLocalDay(date)
  result.setDate(result.getDate() + days)
  return result
}

export function toLocalIsoDate(date: Date) {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join('-')
}

export function formatLocalDay(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

export function isAfterLocalDay(date: Date, today: Date) {
  return toLocalIsoDate(date) > toLocalIsoDate(today)
}
