const EARLIEST_PHOTO_TIME = Date.UTC(1800, 0, 1)
const EXIF_DATE_FIELDS = [
  'DateTimeOriginal',
  'CreateDate',
  'DateTimeDigitized',
] as const
const EXIF_OFFSET_FIELDS = [
  'OffsetTimeOriginal',
  'OffsetTimeDigitized',
] as const
const EXIF_ALLOWED_FIELDS = [
  ...EXIF_DATE_FIELDS,
  ...EXIF_OFFSET_FIELDS,
] as const
const OFFSET_FIELD_BY_DATE = {
  DateTimeOriginal: 'OffsetTimeOriginal',
  CreateDate: 'OffsetTimeDigitized',
  DateTimeDigitized: 'OffsetTimeDigitized',
} as const
const EXIF_DATE_OPTIONS = {
  // exifr still follows the IFD0 pointer needed to reach EXIF, but does not
  // return IFD0 values or enable any other metadata block.
  tiff: false,
  ifd1: false,
  exif: { pick: EXIF_ALLOWED_FIELDS },
  gps: false,
  interop: false,
  xmp: false,
  icc: false,
  iptc: false,
  jfif: false,
  makerNote: false,
  userComment: false,
  chunked: true,
} as const

function endOfTomorrow(now: Date) {
  const limit = new Date(now)
  limit.setDate(limit.getDate() + 1)
  limit.setHours(23, 59, 59, 999)
  return limit.getTime()
}

type WallClockParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  millisecond: number
}

function parseExifOffset(value: unknown) {
  if (typeof value !== 'string') return null
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[2])
  const minutes = Number(match[3])
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) {
    return null
  }
  const totalMinutes = hours * 60 + minutes
  return match[1] === '-' ? -totalMinutes : totalMinutes
}

function validWallClock(parts: WallClockParts) {
  const check = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  ))
  return (
    check.getUTCFullYear() === parts.year &&
    check.getUTCMonth() === parts.month - 1 &&
    check.getUTCDate() === parts.day &&
    check.getUTCHours() === parts.hour &&
    check.getUTCMinutes() === parts.minute &&
    check.getUTCSeconds() === parts.second &&
    check.getUTCMilliseconds() === parts.millisecond
  )
}

function dateFromWallClock(
  parts: WallClockParts,
  offsetMinutes: number | null,
) {
  if (!validWallClock(parts)) return null
  if (offsetMinutes !== null) {
    return new Date(
      Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
        parts.millisecond,
      ) - offsetMinutes * 60_000,
    )
  }

  const localDate = new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  )
  return Number.isFinite(localDate.getTime()) ? localDate : null
}

function localWallClockParts(date: Date): WallClockParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    millisecond: date.getMilliseconds(),
  }
}

function parseExifDate(value: unknown, offsetValue?: unknown) {
  const offsetMinutes = parseExifOffset(offsetValue)
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null
    return offsetMinutes === null
      ? new Date(value)
      : dateFromWallClock(localWallClockParts(value), offsetMinutes)
  }
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  const wallClock = /^(\d{4})([:-])(\d{2})\2(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(trimmed)
  if (wallClock) {
    const [, year, , month, day, hour = '0', minute = '0', second = '0', fraction = '0'] = wallClock
    return dateFromWallClock({
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
      millisecond: Number(fraction.padEnd(3, '0')),
    }, offsetMinutes)
  }

  // ISO/RFC strings with an embedded zone are already absolute. Avoid
  // applying a separately supplied EXIF offset a second time.
  const parsed = new Date(trimmed)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function plausiblePhotoDate(
  value: unknown,
  now: Date,
  offsetValue?: unknown,
) {
  const date = parseExifDate(value, offsetValue)
  if (!date) return null
  const time = date.getTime()
  if (
    !Number.isFinite(time) ||
    time < EARLIEST_PHOTO_TIME ||
    time > endOfTomorrow(now)
  ) return null
  return date
}

/**
 * Reads only capture-time fields and their matching timezone offsets while the
 * original file still has metadata. The returned ISO string is the only value
 * retained by KinSphere; GPS and unrelated blocks remain disabled.
 */
export async function getCapsulePhotoCapturedAt(
  file: File,
  now = new Date(),
) {
  const currentTime = Number.isFinite(now.getTime()) ? now : new Date()

  try {
    const { parse } = await import('exifr/dist/lite.esm.mjs')
    const metadata = await parse(file, EXIF_DATE_OPTIONS)
    for (const field of EXIF_DATE_FIELDS) {
      const offsetField = OFFSET_FIELD_BY_DATE[field]
      const capturedAt = plausiblePhotoDate(
        metadata?.[field],
        currentTime,
        metadata?.[offsetField],
      )
      if (capturedAt) return capturedAt.toISOString()
    }
  } catch {
    // Unsupported, malformed, and HEIC metadata must never block photo upload.
  }

  const fileTimestamp = file.lastModified > 0
    ? plausiblePhotoDate(new Date(file.lastModified), currentTime)
    : null
  return (fileTimestamp ?? currentTime).toISOString()
}
