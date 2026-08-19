import { beforeEach, describe, expect, it, vi } from 'vitest'

const exifrMocks = vi.hoisted(() => ({
  parse: vi.fn(),
}))

vi.mock('exifr/dist/lite.esm.mjs', () => ({
  parse: exifrMocks.parse,
}))

import { getCapsulePhotoCapturedAt } from './capsulePhotoDate'

const now = new Date('2026-08-29T12:00:00.000Z')

function photo(lastModified = new Date('2024-03-04T05:06:07.000Z').getTime()) {
  return new File(['photo'], 'family.jpg', {
    type: 'image/jpeg',
    lastModified,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getCapsulePhotoCapturedAt', () => {
  it('reads only capture date fields and prefers DateTimeOriginal', async () => {
    exifrMocks.parse.mockResolvedValue({
      DateTimeOriginal: new Date('2005-06-07T08:09:10.000Z'),
      CreateDate: new Date('2006-07-08T09:10:11.000Z'),
      GPSLatitude: 25.2048,
    })
    const file = photo()

    await expect(getCapsulePhotoCapturedAt(file, now)).resolves.toBe(
      '2005-06-07T08:09:10.000Z',
    )
    expect(exifrMocks.parse).toHaveBeenCalledWith(file, expect.objectContaining({
      exif: {
        pick: [
          'DateTimeOriginal',
          'CreateDate',
          'DateTimeDigitized',
          'OffsetTimeOriginal',
          'OffsetTimeDigitized',
        ],
      },
      gps: false,
      xmp: false,
      iptc: false,
      makerNote: false,
      userComment: false,
      chunked: true,
    }))
  })

  it('combines DateTimeOriginal with its camera timezone on any upload device', async () => {
    exifrMocks.parse.mockResolvedValue({
      // exifr revives zone-less camera timestamps as local Date values.
      DateTimeOriginal: new Date(2005, 5, 7, 8, 9, 10),
      OffsetTimeOriginal: '+05:30',
    })

    await expect(getCapsulePhotoCapturedAt(photo(), now)).resolves.toBe(
      new Date(Date.UTC(2005, 5, 7, 2, 39, 10)).toISOString(),
    )
  })

  it('uses OffsetTimeDigitized for CreateDate and legacy DateTimeDigitized strings', async () => {
    exifrMocks.parse
      .mockResolvedValueOnce({
        DateTimeOriginal: 'not a date',
        CreateDate: '1998:12:03 14:05:06',
        OffsetTimeDigitized: '-03:30',
      })
      .mockResolvedValueOnce({
        DateTimeOriginal: 'not a date',
        CreateDate: 'not a date',
        DateTimeDigitized: '1998:12:03 14:05:06',
        OffsetTimeDigitized: '-03:30',
      })

    await expect(getCapsulePhotoCapturedAt(photo(), now)).resolves.toBe(
      new Date(Date.UTC(1998, 11, 3, 17, 35, 6)).toISOString(),
    )
    await expect(getCapsulePhotoCapturedAt(photo(), now)).resolves.toBe(
      new Date(Date.UTC(1998, 11, 3, 17, 35, 6)).toISOString(),
    )
  })

  it('ignores malformed and out-of-range offsets without losing a valid date', async () => {
    const original = new Date(2010, 6, 8, 21, 10, 11)
    exifrMocks.parse
      .mockResolvedValueOnce({
        DateTimeOriginal: original,
        OffsetTimeOriginal: '+5:30',
      })
      .mockResolvedValueOnce({
        DateTimeOriginal: original,
        OffsetTimeOriginal: '+14:01',
      })

    await expect(getCapsulePhotoCapturedAt(photo(), now)).resolves.toBe(
      original.toISOString(),
    )
    await expect(getCapsulePhotoCapturedAt(photo(), now)).resolves.toBe(
      original.toISOString(),
    )
  })

  it('does not apply an EXIF offset twice to a date string with an embedded zone', async () => {
    exifrMocks.parse.mockResolvedValue({
      DateTimeOriginal: '2005-06-07T08:09:10.000Z',
      OffsetTimeOriginal: '+05:30',
    })

    await expect(getCapsulePhotoCapturedAt(photo(), now)).resolves.toBe(
      '2005-06-07T08:09:10.000Z',
    )
  })

  it('accepts legacy DateTimeDigitized strings when earlier fields are unusable', async () => {
    exifrMocks.parse.mockResolvedValue({
      DateTimeOriginal: 'not a date',
      DateTimeDigitized: '1998:12:03 14:05:06',
    })

    const result = await getCapsulePhotoCapturedAt(photo(), now)
    const expected = new Date(1998, 11, 3, 14, 5, 6).toISOString()
    expect(result).toBe(expected)
  })

  it('ignores implausible EXIF dates and falls back to File.lastModified', async () => {
    exifrMocks.parse.mockResolvedValue({
      DateTimeOriginal: new Date('1799-12-31T23:59:59.000Z'),
    })
    const modified = new Date('2019-02-03T04:05:06.000Z')

    await expect(
      getCapsulePhotoCapturedAt(photo(modified.getTime()), now),
    ).resolves.toBe(modified.toISOString())
  })

  it('falls back to the file timestamp when EXIF parsing fails', async () => {
    exifrMocks.parse.mockRejectedValue(new Error('unsupported HEIC metadata'))
    const modified = new Date('2020-01-02T03:04:05.000Z')
    const heic = new File(['heic'], 'family.heic', {
      type: 'image/heic',
      lastModified: modified.getTime(),
    })

    await expect(getCapsulePhotoCapturedAt(heic, now)).resolves.toBe(
      modified.toISOString(),
    )
  })

  it('uses the current time when EXIF and the file timestamp are implausible', async () => {
    exifrMocks.parse.mockResolvedValue(undefined)
    const implausibleFutureTimestamp = new Date('2100-01-01T00:00:00.000Z').getTime()

    await expect(
      getCapsulePhotoCapturedAt(photo(implausibleFutureTimestamp), now),
    ).resolves.toBe(
      now.toISOString(),
    )
  })

  it('treats a zero file timestamp as missing rather than January 1970', async () => {
    exifrMocks.parse.mockResolvedValue(undefined)

    await expect(getCapsulePhotoCapturedAt(photo(0), now)).resolves.toBe(
      now.toISOString(),
    )
  })
})
