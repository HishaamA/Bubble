import { describe, expect, it } from 'vitest'
import {
  validateEquirectangularDimensions,
  validatePanoramaCaptureDimensions,
} from './equirectangular'

describe('equirectangular validation', () => {
  it('accepts a 2:1 panorama', () => {
    expect(validateEquirectangularDimensions({ width: 4096, height: 2048 })).toMatchObject({
      valid: true,
      ratio: 2,
    })
  })

  it('rejects an ordinary phone-photo aspect ratio', () => {
    expect(validateEquirectangularDimensions({ width: 4032, height: 3024 })).toMatchObject({
      valid: false,
      ratio: 4 / 3,
    })
  })

  it('rejects a panorama too small for the shared viewer contract', () => {
    expect(
      validateEquirectangularDimensions({ width: 800, height: 400 }),
    ).toMatchObject({
      valid: false,
      ratio: 2,
    })
  })
})

describe('phone panorama validation', () => {
  it('accepts a wide native panorama and marks it for normalization', () => {
    expect(
      validatePanoramaCaptureDimensions({ width: 8000, height: 2000 }),
    ).toMatchObject({
      valid: true,
      ratio: 4,
      needsNormalization: true,
    })
  })

  it('keeps an exact 2:1 panorama without another client-side conversion', () => {
    expect(
      validatePanoramaCaptureDimensions({ width: 4096, height: 2048 }),
    ).toMatchObject({
      valid: true,
      ratio: 2,
      needsNormalization: false,
    })
  })

  it('rejects an ordinary single phone-camera frame', () => {
    expect(
      validatePanoramaCaptureDimensions({ width: 4032, height: 3024 }),
    ).toMatchObject({
      valid: false,
      ratio: 4 / 3,
    })
  })
})
