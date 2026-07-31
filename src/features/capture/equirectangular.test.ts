import { describe, expect, it } from 'vitest'
import { validateEquirectangularDimensions } from './equirectangular'

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
