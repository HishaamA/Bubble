import { describe, expect, it } from 'vitest'
import { calculatePanoramaCrop } from './processPanorama'

describe('calculatePanoramaCrop', () => {
  it('keeps an exact 2:1 panorama and caps the viewer derivative', () => {
    expect(calculatePanoramaCrop(6000, 3000)).toEqual({
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 6000,
      sourceHeight: 3000,
      viewerWidth: 4096,
      viewerHeight: 2048,
      thumbnailWidth: 640,
      thumbnailHeight: 320,
    })
  })

  it('center-crops an accepted near-2:1 image to exact derivatives', () => {
    const crop = calculatePanoramaCrop(4100, 2000)
    expect(crop.sourceX).toBe(50)
    expect(crop.sourceWidth).toBe(4000)
    expect(crop.sourceHeight).toBe(2000)
    expect(crop.viewerWidth / crop.viewerHeight).toBe(2)
  })

  it('rejects ordinary camera aspect ratios', () => {
    expect(() => calculatePanoramaCrop(4032, 3024)).toThrow(
      'Choose a 2:1 equirectangular panorama.',
    )
  })
})
