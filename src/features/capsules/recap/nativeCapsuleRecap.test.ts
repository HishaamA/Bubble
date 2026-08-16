import { beforeEach, describe, expect, it, vi } from 'vitest'

const capacitor = vi.hoisted(() => ({
  isNativePlatform: vi.fn(),
  getPlatform: vi.fn(),
  isPluginAvailable: vi.fn(),
}))
const recapPlugin = vi.hoisted(() => ({
  stageImage: vi.fn(),
  renderRecap: vi.fn(),
  shareRecap: vi.fn(),
  discardArtifacts: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: capacitor,
  registerPlugin: vi.fn(() => recapPlugin),
}))

import {
  CAPSULE_RECAP_FRAMES_PER_IMAGE,
  CAPSULE_RECAP_MILLISECONDS_PER_IMAGE,
  discardNativeCapsuleRecapArtifacts,
  isNativeCapsuleRecapAvailable,
  renderNativeCapsuleRecap,
  shareNativeCapsuleRecap,
  stageNativeCapsuleRecapImage,
} from './nativeCapsuleRecap'

describe('native capsule recap bridge', () => {
  beforeEach(() => {
    capacitor.isNativePlatform.mockReset().mockReturnValue(true)
    capacitor.getPlatform.mockReset().mockReturnValue('ios')
    capacitor.isPluginAvailable.mockReset().mockReturnValue(true)
    recapPlugin.stageImage.mockReset().mockResolvedValue({
      path: 'file:///tmp/CapsuleRecapStaging/photo.jpg',
    })
    recapPlugin.renderRecap.mockReset().mockResolvedValue({
      fileUri: 'file:///tmp/CapsuleRecaps/recap.mp4',
      width: 1080,
      height: 1920,
      frameRate: 30,
      framesPerImage: 6,
      durationMs: 400,
      imageCount: 2,
    })
    recapPlugin.shareRecap.mockReset().mockResolvedValue({ completed: true })
    recapPlugin.discardArtifacts.mockReset().mockResolvedValue({ removedCount: 1 })
  })

  it.each(['ios', 'android'])('recognizes the native bridge on %s', (platform) => {
    capacitor.getPlatform.mockReturnValue(platform)

    expect(isNativeCapsuleRecapAvailable()).toBe(true)
    expect(capacitor.isPluginAvailable).toHaveBeenCalledWith('CapsuleRecap')
  })

  it('stages images one data URL at a time before rendering ordered paths', async () => {
    const first = await stageNativeCapsuleRecapImage({
      dataUrl: 'data:image/jpeg;base64,Zmlyc3Q=',
    })
    const second = await stageNativeCapsuleRecapImage({
      dataUrl: 'data:image/png;base64,c2Vjb25k',
    })

    await expect(
      renderNativeCapsuleRecap({ imagePaths: [first.path, second.path] }),
    ).resolves.toMatchObject({
      framesPerImage: CAPSULE_RECAP_FRAMES_PER_IMAGE,
      durationMs: 2 * CAPSULE_RECAP_MILLISECONDS_PER_IMAGE,
      imageCount: 2,
    })

    expect(recapPlugin.stageImage).toHaveBeenCalledTimes(2)
    expect(recapPlugin.renderRecap).toHaveBeenCalledWith({
      imagePaths: [first.path, second.path],
    })
  })

  it('opens the native share sheet for the rendered MP4', async () => {
    await expect(
      shareNativeCapsuleRecap('file:///tmp/CapsuleRecaps/recap.mp4'),
    ).resolves.toEqual({ completed: true })

    expect(recapPlugin.shareRecap).toHaveBeenCalledWith({
      fileUri: 'file:///tmp/CapsuleRecaps/recap.mp4',
    })
  })

  it('cleans staged and rendered files through the constrained native bridge', async () => {
    await discardNativeCapsuleRecapArtifacts([
      'file:///tmp/CapsuleRecapStaging/photo.jpg',
      'file:///tmp/CapsuleRecapStaging/photo.jpg',
      '  file:///tmp/CapsuleRecaps/recap.mp4  ',
      '',
    ])

    expect(recapPlugin.discardArtifacts).toHaveBeenCalledWith({
      fileUris: [
        'file:///tmp/CapsuleRecapStaging/photo.jpg',
        'file:///tmp/CapsuleRecaps/recap.mp4',
      ],
    })
  })

  it('does not invoke the bridge on the web or with invalid inputs', async () => {
    capacitor.isNativePlatform.mockReturnValue(false)
    capacitor.getPlatform.mockReturnValue('web')

    expect(isNativeCapsuleRecapAvailable()).toBe(false)
    await expect(
      stageNativeCapsuleRecapImage({ dataUrl: 'data:image/jpeg;base64,eA==' }),
    ).rejects.toThrow(/not available/i)
    expect(recapPlugin.stageImage).not.toHaveBeenCalled()

    capacitor.isNativePlatform.mockReturnValue(true)
    capacitor.getPlatform.mockReturnValue('ios')
    await expect(
      renderNativeCapsuleRecap({ imagePaths: [] }),
    ).rejects.toThrow(/at least one image/i)
    await expect(shareNativeCapsuleRecap('   ')).rejects.toThrow(/file is required/i)
  })

  it('rejects non-image data and recap sets above the native safety limit', async () => {
    await expect(
      stageNativeCapsuleRecapImage({ dataUrl: 'data:text/plain;base64,eA==' }),
    ).rejects.toThrow(/image data URLs/i)
    await expect(
      renderNativeCapsuleRecap({
        imagePaths: Array.from({ length: 151 }, (_, index) => `/tmp/${index}.jpg`),
      }),
    ).rejects.toThrow(/at most 150 images/i)
  })
})
