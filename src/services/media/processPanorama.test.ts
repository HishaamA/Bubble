import { describe, expect, it } from 'vitest'
import {
  calculatePanoramaCrop,
  calculatePanoramaRenderPlan,
} from './processPanorama'

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

describe('calculatePanoramaRenderPlan', () => {
  it('retains the full horizontal sweep of a wide phone panorama', () => {
    expect(calculatePanoramaRenderPlan(8000, 2000)).toMatchObject({
      mode: 'wide-panorama-fit',
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 8000,
      sourceHeight: 2000,
      viewerWidth: 4096,
      viewerHeight: 2048,
      contentTop: 0.25,
      contentHeight: 0.5,
    })
  })

  it('uses the existing exact crop for an equirectangular input', () => {
    expect(calculatePanoramaRenderPlan(4100, 2000)).toMatchObject({
      mode: 'equirectangular-crop',
      sourceX: 50,
      sourceWidth: 4000,
      contentTop: 0,
      contentHeight: 1,
    })
  })

  it('rejects an ordinary single phone-camera frame', () => {
    expect(() => calculatePanoramaRenderPlan(4032, 3024)).toThrow(
      'Use a wide photo captured with Pano or Panorama mode.',
    )
  })
})
