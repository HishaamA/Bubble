import { beforeEach, describe, expect, it, vi } from 'vitest'

const exifrMocks = vi.hoisted(() => ({ parse: vi.fn() }))
vi.mock('exifr/dist/lite.esm.mjs', () => ({ parse: exifrMocks.parse }))

import { estimateReferenceFieldOfView, estimateReferenceHorizontalFovs } from './referenceFieldOfView'

const portrait = { width: 1080, height: 1920 }
const original = new File(['original image bytes'], 'room.jpg', { type: 'image/jpeg' })

beforeEach(() => {
  exifrMocks.parse.mockReset().mockResolvedValue(undefined)
})

describe('reference photo field-of-view estimates', () => {
  it.each([
    [1080, 1920, 40.6],
    [1920, 1080, 66.6],
    [1000, 1000, 56.1],
    [4032, 3024, 62.2],
    [288, 512, 40.6],
  ])('converts the fallback diagonal to the actual %i x %i aspect', async (width, height, horizontalFovDegrees) => {
    await expect(estimateReferenceFieldOfView(original, { width, height })).resolves.toEqual({
      horizontalFovDegrees,
      source: 'diagonal-fallback',
      estimated: true,
    })
  })

  it('uses 35mm-equivalent focal length but retains only the estimate', async () => {
    exifrMocks.parse.mockResolvedValue({ FocalLengthIn35mmFormat: 28, GPSLatitude: 25, Make: 'Private camera' })
    await expect(estimateReferenceFieldOfView(original, portrait)).resolves.toEqual({
      horizontalFovDegrees: 41.5,
      source: 'exif-35mm-equivalent',
      estimated: true,
    })
    expect(exifrMocks.parse).toHaveBeenCalledWith(original, {
      tiff: false,
      ifd1: false,
      exif: { pick: [0xa405] },
      gps: false,
      interop: false,
      xmp: false,
      icc: false,
      iptc: false,
      jfif: false,
      makerNote: false,
      userComment: false,
      chunked: true,
    })
    expect(original.size).toBe('original image bytes'.length)
  })

  it('uses upright dimensions without applying camera orientation a second time', async () => {
    exifrMocks.parse.mockResolvedValue({ FocalLengthIn35mmFormat: 28, Orientation: 6, ExifImageWidth: 1920, ExifImageHeight: 1080 })
    const upright = await estimateReferenceFieldOfView(original, portrait)
    const resized = await estimateReferenceFieldOfView(original, { width: 288, height: 512 })
    expect(upright.horizontalFovDegrees).toBe(41.5)
    expect(resized).toEqual(upright)
  })

  it('reads the numeric tag through the installed parser from a minimal EXIF JPEG', async () => {
    const { parse } = await vi.importActual<typeof import('exifr/dist/lite.esm.mjs')>('exifr/dist/lite.esm.mjs')
    exifrMocks.parse.mockImplementation(parse)
    // Synthetic EXIF only: IFD0 orientation 6, EXIF pointer, and focal35=28.
    const tiff = new Uint8Array(56)
    const view = new DataView(tiff.buffer)
    tiff.set([0x49, 0x49, 42, 0, 8, 0, 0, 0])
    view.setUint16(8, 2, true)
    view.setUint16(10, 0x0112, true)
    view.setUint16(12, 3, true)
    view.setUint32(14, 1, true)
    view.setUint16(18, 6, true)
    view.setUint16(22, 0x8769, true)
    view.setUint16(24, 4, true)
    view.setUint32(26, 1, true)
    view.setUint32(30, 38, true)
    view.setUint16(38, 1, true)
    view.setUint16(40, 0xa405, true)
    view.setUint16(42, 3, true)
    view.setUint32(44, 1, true)
    view.setUint16(48, 28, true)
    const jpeg = new Blob([
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 64, 0x45, 0x78, 0x69, 0x66, 0, 0]),
      tiff,
      new Uint8Array([0xff, 0xd9]),
    ], { type: 'image/jpeg' })
    await expect(estimateReferenceFieldOfView(jpeg, portrait)).resolves.toEqual({
      horizontalFovDegrees: 41.5,
      source: 'exif-35mm-equivalent',
      estimated: true,
    })
  })

  it.each([undefined, null, 0, -28, NaN, Infinity, '28', [28], {}])('ignores unusable 35mm focal length %s', async (focal35) => {
    exifrMocks.parse.mockResolvedValue({ FocalLengthIn35mmFormat: focal35, FocalLength: 4.5 })
    expect(await estimateReferenceFieldOfView(original, portrait)).toEqual({
      horizontalFovDegrees: 40.6,
      source: 'diagonal-fallback',
      estimated: true,
    })
  })

  it('falls back when a format has no readable EXIF', async () => {
    exifrMocks.parse.mockRejectedValue(new Error('Unsupported metadata'))
    expect((await estimateReferenceFieldOfView(original, portrait)).source).toBe('diagonal-fallback')
  })

  it.each([[1, 110], [1000, 25]])('bounds an extreme focal length %i mm to %i degrees', async (focal35, expected) => {
    exifrMocks.parse.mockResolvedValue({ FocalLengthIn35mmFormat: focal35 })
    expect((await estimateReferenceFieldOfView(original, portrait)).horizontalFovDegrees).toBe(expected)
  })

  it.each([[0, 1920], [1080, -1], [NaN, 1920], [1080, Infinity], [10.5, 20], [Number.MAX_VALUE, 1]])(
    'rejects invalid normalized dimensions %s x %s before reading EXIF', async (width, height) => {
      await expect(estimateReferenceFieldOfView(original, { width, height })).rejects.toThrow('dimensions')
      expect(exifrMocks.parse).not.toHaveBeenCalled()
    },
  )

  it('returns a per-image array in original order without sending metadata', async () => {
    const second = new Blob(['another original'], { type: 'image/png' })
    exifrMocks.parse.mockImplementation(async (file: Blob) => file === original ? { FocalLengthIn35mmFormat: 28 } : undefined)
    await expect(estimateReferenceHorizontalFovs([
      { original, ...portrait },
      { original: second, width: 1920, height: 1080 },
    ])).resolves.toEqual([41.5, 66.6])
  })

  it('rejects an unbounded batch or invalid dimensions before reading any original', async () => {
    await expect(estimateReferenceHorizontalFovs([])).rejects.toThrow('one and four')
    await expect(estimateReferenceHorizontalFovs(Array.from({ length: 5 }, () => ({ original, ...portrait })))).rejects.toThrow('one and four')
    await expect(estimateReferenceHorizontalFovs([{ original, ...portrait }, { original, width: 0, height: 1920 }])).rejects.toThrow('dimensions')
    expect(exifrMocks.parse).not.toHaveBeenCalled()
  })
})
