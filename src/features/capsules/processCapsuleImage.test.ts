import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acceptsCapsuleImage,
  hasSafeCapsuleImageDimensions,
  processCapsuleImage,
} from './processCapsuleImage'

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
  } else {
    Reflect.deleteProperty(URL, 'createObjectURL')
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
  } else {
    Reflect.deleteProperty(URL, 'revokeObjectURL')
  }
})

describe('acceptsCapsuleImage', () => {
  it('accepts ordinary portrait and landscape image files without an aspect-ratio rule', () => {
    expect(acceptsCapsuleImage({ type: 'image/jpeg', size: 2_000_000 })).toBe(true)
    expect(acceptsCapsuleImage({ type: 'image/heic', size: 5_000_000 })).toBe(true)
    expect(acceptsCapsuleImage({ type: 'image/png', size: 300_000 })).toBe(true)
  })

  it('rejects non-images, empty files, and files over 25 MB', () => {
    expect(acceptsCapsuleImage({ type: 'video/mp4', size: 1_000_000 })).toBe(false)
    expect(acceptsCapsuleImage({ type: 'image/jpeg', size: 0 })).toBe(false)
    expect(acceptsCapsuleImage({ type: 'image/jpeg', size: 26 * 1024 * 1024 })).toBe(false)
  })

  it('bounds decoded dimensions without overflowing the pixel calculation', () => {
    expect(hasSafeCapsuleImageDimensions(10_000, 8_000)).toBe(true)
    expect(hasSafeCapsuleImageDimensions(10_000, 8_001)).toBe(false)
    expect(hasSafeCapsuleImageDimensions(0, 1_000)).toBe(false)
    expect(hasSafeCapsuleImageDimensions(Number.MAX_SAFE_INTEGER, 2)).toBe(false)
  })

  it('rejects an oversized decoded photo before allocating output canvases', async () => {
    class OversizedImage {
      decoding = 'async'
      src = ''
      naturalWidth = 10_000
      naturalHeight = 10_000

      async decode() {}
    }

    vi.stubGlobal('Image', OversizedImage)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:oversized-capsule-photo'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })

    await expect(processCapsuleImage(
      new File(['photo'], 'oversized.jpg', { type: 'image/jpeg' }),
    )).rejects.toThrow(/too large to prepare safely/i)

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:oversized-capsule-photo')
  })
})
