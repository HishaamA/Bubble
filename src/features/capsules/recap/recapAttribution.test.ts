import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drawRecapAttribution, loadRecapAvatar, prepareAttributedRecapFrame } from './recapAttribution'

const contributor = { contributorName: 'Simreen Siraj', contributorAvatarUrl: 'https://images.example/simreen.jpg' }
const NativeURL = URL

class DecodedImage {
  decoding = 'async'
  src = ''
  naturalWidth = 900
  naturalHeight = 1200
  decode = vi.fn().mockResolvedValue(undefined)
}

function drawingContext() {
  return {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(),
    fill: vi.fn(), clip: vi.fn(), fillText: vi.fn(), stroke: vi.fn(),
    fillRect: vi.fn(), drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D
}

beforeEach(() => {
  let nextUrl = 0
  vi.stubGlobal('URL', Object.assign(class extends NativeURL {}, {
    createObjectURL: vi.fn(() => `blob:recap-attribution-${++nextUrl}`),
    revokeObjectURL: vi.fn(),
  }))
  vi.stubGlobal('Image', DecodedImage)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['avatar']) }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('recap attribution', () => {
  it('renders a circular uploader photo in the top right and returns canvas state intact', () => {
    const context = drawingContext()
    const avatar = new DecodedImage() as unknown as HTMLImageElement
    drawRecapAttribution(context, contributor, avatar, 1080)
    expect(context.arc).toHaveBeenCalledWith(972, 108, 64.8, 0, Math.PI * 2)
    expect(context.drawImage).toHaveBeenCalledWith(avatar, 0, 150, 900, 900, 907.2, 43.2, 129.6, 129.6)
    expect(context.fillText).not.toHaveBeenCalled()
    expect(context.save).toHaveBeenCalledTimes(2)
    expect(context.restore).toHaveBeenCalledTimes(2)
  })

  it('draws uploader initials when there is no profile photo', () => {
    const context = drawingContext()
    drawRecapAttribution(context, contributor, null, 720)
    expect(context.fillText).toHaveBeenCalledWith('SS', 648, 72, 73.44)
    expect(context.drawImage).not.toHaveBeenCalled()
  })

  it('prepares a native portrait frame with attribution and releases all private image URLs', async () => {
    const context = drawingContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      ((contextId: string) => contextId === '2d' ? context : null) as HTMLCanvasElement['getContext'],
    )
    const encoded = new Blob(['composited frame'], { type: 'image/jpeg' })
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(encoded))
    await expect(prepareAttributedRecapFrame(new Blob(['family photo']), contributor)).resolves.toBe(encoded)
    expect(context.drawImage).toHaveBeenCalledTimes(2)
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recap-attribution-1')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recap-attribution-2')
    expect(fetch).toHaveBeenCalledWith(contributor.contributorAvatarUrl, {
      referrerPolicy: 'no-referrer', signal: expect.any(AbortSignal),
    })
  })

  it('falls back to initials for avatar download or decode failures', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    await expect(loadRecapAvatar(contributor)).resolves.toBeNull()
    class BrokenAvatar extends DecodedImage {
      override decode = vi.fn().mockRejectedValue(new Error('bad image'))
    }
    vi.stubGlobal('Image', BrokenAvatar)
    await expect(loadRecapAvatar(contributor)).resolves.toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recap-attribution-1')
  })

  it('releases the avatar and photo if native frame composition cannot start', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(prepareAttributedRecapFrame(new Blob(['photo']), contributor)).rejects.toThrow('could not prepare')
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('never fetches untrusted or missing profile sources', async () => {
    await expect(loadRecapAvatar({ contributorName: 'Mum' })).resolves.toBeNull()
    await expect(loadRecapAvatar({ contributorName: 'Mum', contributorAvatarUrl: 'file:///private/avatar.jpg' })).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds a hung avatar endpoint and aborts its request without blocking the recap', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementation(() => new Promise(() => undefined))
    const pending = loadRecapAvatar(contributor)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toBeNull()
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('applies the same deadline to a slow body and ignores bytes arriving after expiry', async () => {
    vi.useFakeTimers()
    let finishBody!: (blob: Blob) => void
    vi.mocked(fetch).mockResolvedValue({
      ok: true, blob: () => new Promise<Blob>((resolve) => { finishBody = resolve }),
    } as Response)
    const pending = loadRecapAvatar(contributor)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toBeNull()
    finishBody(new Blob(['late avatar']))
    await vi.advanceTimersByTimeAsync(0)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases an avatar URL when decoding hangs and never returns the late image', async () => {
    vi.useFakeTimers()
    let finishDecode!: () => void
    class HungAvatar extends DecodedImage {
      override decode = vi.fn(() => new Promise<void>((resolve) => { finishDecode = resolve }))
    }
    vi.stubGlobal('Image', HungAvatar)
    const pending = loadRecapAvatar(contributor)
    await vi.advanceTimersByTimeAsync(0)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:recap-attribution-1')
    finishDecode()
    await vi.advanceTimersByTimeAsync(0)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects oversized declared bodies before reading or allocating a decoded image', async () => {
    const blob = vi.fn()
    vi.mocked(fetch).mockResolvedValue({
      ok: true, headers: new Headers({ 'content-length': String(2 * 1024 * 1024 + 1) }), blob,
    } as unknown as Response)
    await expect(loadRecapAvatar(contributor)).resolves.toBeNull()
    expect(blob).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('caps a streaming avatar even when no size is declared and cancels the reader', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const releaseLock = vi.fn()
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(1024 * 1024) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(1024 * 1024 + 1) })
    vi.mocked(fetch).mockResolvedValue({
      ok: true, headers: new Headers(), body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response)
    await expect(loadRecapAvatar(contributor)).resolves.toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('cancels a stalled streaming body at the deadline and releases its reader lock', async () => {
    vi.useFakeTimers()
    let finishRead!: (chunk: { done: boolean }) => void
    const read = vi.fn(() => new Promise((resolve) => { finishRead = resolve }))
    const cancel = vi.fn(async () => { finishRead({ done: true }) })
    const releaseLock = vi.fn()
    vi.mocked(fetch).mockResolvedValue({
      ok: true, body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response)
    const pending = loadRecapAvatar(contributor)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toBeNull()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('clears its deadline after successful loading and releases its URL only once', async () => {
    vi.useFakeTimers()
    const avatar = await loadRecapAvatar(contributor)
    expect(avatar?.image).toBeTruthy()
    expect(vi.getTimerCount()).toBe(0)
    avatar?.release()
    avatar?.release()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })
})
