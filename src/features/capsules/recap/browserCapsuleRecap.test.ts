import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapsulePhoto } from '../types'
import { renderBrowserCapsuleRecap } from './browserCapsuleRecap'

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
const originalCaptureStream = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'captureStream',
)
const originalGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'getContext',
)

let nextObjectUrl = 0
let loadedSources: string[]
let stoppedTrack: ReturnType<typeof vi.fn>

function photo(id: string, image: string): CapsulePhoto {
  return {
    id,
    capsuleId: 'weekly-one',
    image,
    thumbnail: image,
    width: 900,
    height: 1200,
    caption: id,
    capturedAt: `2026-08-25T12:00:0${id}.000Z`,
    contributorName: 'Family',
    ownedByCurrentUser: false,
  }
}

class FakeImage {
  decoding = 'async'
  src = ''
  naturalWidth = 900
  naturalHeight = 1200

  async decode() {
    loadedSources.push(this.src)
  }
}

class FakeMediaRecorder {
  static isTypeSupported() {
    return true
  }

  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onstop: ((event: Event) => void) | null = null

  start() {
    this.state = 'recording'
  }

  stop() {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    this.ondataavailable?.({
      data: new Blob(['recap'], { type: 'video/mp4' }),
    } as BlobEvent)
    this.onstop?.(new Event('stop'))
  }
}

function restoreDescriptor(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(target, property, descriptor)
  else Reflect.deleteProperty(target, property)
}

beforeEach(() => {
  nextObjectUrl = 0
  loadedSources = []
  stoppedTrack = vi.fn()
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)

  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:capsule-recap-${++nextObjectUrl}`),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    value: vi.fn(() => ({
      getTracks: () => [{ stop: stoppedTrack }],
    })),
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => ({
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    })),
  })
  vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler) => {
    if (typeof handler === 'function') handler()
    return 1
  }) as typeof window.setTimeout)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  restoreDescriptor(URL, 'createObjectURL', originalCreateObjectURL)
  restoreDescriptor(URL, 'revokeObjectURL', originalRevokeObjectURL)
  restoreDescriptor(HTMLCanvasElement.prototype, 'captureStream', originalCaptureStream)
  restoreDescriptor(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
})

describe('renderBrowserCapsuleRecap', () => {
  it('fetches a signed remote image into a same-origin object URL before drawing', async () => {
    const remoteBlob = new Blob(['photo'], { type: 'image/jpeg' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(remoteBlob),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await renderBrowserCapsuleRecap([
      photo('1', 'https://storage.example/signed-photo.jpg?token=secret'),
    ])

    expect(fetchMock).toHaveBeenCalledWith(
      'https://storage.example/signed-photo.jpg?token=secret',
    )
    expect(URL.createObjectURL).toHaveBeenCalledWith(remoteBlob)
    expect(loadedSources).toEqual(['blob:capsule-recap-1'])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:capsule-recap-1')
    expect(stoppedTrack).toHaveBeenCalledOnce()
    expect(result.type).toBe('video/mp4;codecs=h264')
  })

  it('revokes every prepared object URL when any image fails to decode', async () => {
    class PartiallyBrokenImage extends FakeImage {
      override async decode() {
        await super.decode()
        if (this.src.endsWith('-2')) throw new Error('decode failed')
      }
    }
    vi.stubGlobal('Image', PartiallyBrokenImage)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (source: string) => ({
      ok: true,
      blob: async () => new Blob([source], { type: 'image/jpeg' }),
    })))

    await expect(renderBrowserCapsuleRecap([
      photo('1', 'https://storage.example/one.jpg'),
      photo('2', 'https://storage.example/two.jpg'),
    ])).rejects.toThrow('decode failed')

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:capsule-recap-1')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:capsule-recap-2')
  })
})
