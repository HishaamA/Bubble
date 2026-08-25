import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanoramaScene } from '../../../viewer'

const capacitor = vi.hoisted(() => ({
  isNativePlatform: vi.fn(),
  getPlatform: vi.fn(),
  isPluginAvailable: vi.fn(),
}))
const panoramaPlugin = vi.hoisted(() => ({
  open: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: capacitor,
  registerPlugin: vi.fn(() => panoramaPlugin),
}))

import {
  MAX_NATIVE_CARDBOARD_IMAGE_BYTES,
  blobToBase64,
  nativeCardboardPanoramaAvailable,
  presentNativeCardboardPanorama,
} from './nativeCardboardPanorama'

const scene: PanoramaScene = {
  id: 'dinner',
  panorama: '/assets/panoramas/dinner.jpg',
  alt: 'Dinner panorama',
  title: 'Sunday dinner',
  yaw: 12,
  pitch: -2,
}

describe('native Cardboard panorama bridge', () => {
  beforeEach(() => {
    capacitor.isNativePlatform.mockReset().mockReturnValue(true)
    capacitor.getPlatform.mockReset().mockReturnValue('android')
    capacitor.isPluginAvailable.mockReset().mockReturnValue(true)
    panoramaPlugin.open.mockReset().mockResolvedValue({ launched: true })
  })

  it('is offered only by the installed native Android plugin', () => {
    expect(nativeCardboardPanoramaAvailable()).toBe(true)

    capacitor.getPlatform.mockReturnValue('ios')
    expect(nativeCardboardPanoramaAvailable()).toBe(false)

    capacitor.getPlatform.mockReturnValue('android')
    capacitor.isPluginAvailable.mockReturnValue(false)
    expect(nativeCardboardPanoramaAvailable()).toBe(false)
  })

  it('encodes the selected panorama and preserves its initial view', async () => {
    const sourceBlob = new Blob(['panorama'], { type: 'image/jpeg' })

    await expect(
      presentNativeCardboardPanorama({ scene, sourceBlob }),
    ).resolves.toBe(true)

    expect(panoramaPlugin.open).toHaveBeenCalledWith({
      dataBase64: 'cGFub3JhbWE=',
      mimeType: 'image/jpeg',
      title: 'Sunday dinner',
      initialYaw: 12,
      initialPitch: -2,
    })
  })

  it('does not allocate or send an oversized image', async () => {
    const sourceBlob = {
      size: MAX_NATIVE_CARDBOARD_IMAGE_BYTES + 1,
      type: 'image/jpeg',
    } as Blob

    await expect(
      presentNativeCardboardPanorama({ scene, sourceBlob }),
    ).resolves.toBe(false)
    expect(panoramaPlugin.open).not.toHaveBeenCalled()
  })

  it('falls back cleanly when native launch fails', async () => {
    panoramaPlugin.open.mockRejectedValue(new Error('renderer unavailable'))

    await expect(
      presentNativeCardboardPanorama({
        scene,
        sourceBlob: new Blob(['panorama'], { type: 'image/png' }),
      }),
    ).resolves.toBe(false)
  })

  it('returns only the base64 payload from a data URL', async () => {
    await expect(blobToBase64(new Blob(['hello']))).resolves.toBe('aGVsbG8=')
  })
})
