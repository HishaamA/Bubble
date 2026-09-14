import { describe, expect, it, vi } from 'vitest'
import { validateGeneratedPanorama, MAX_GENERATED_PANORAMA_BYTES } from './validateGeneratedPanorama'

const image = new Blob(['encoded image'], { type: 'image/jpeg' })

describe('generated panorama artifact validation', () => {
  it.each([[1024, 512], [4096, 2048], [8192, 4096]])('accepts decoded full sphere %i × %i', async (width, height) => {
    const decode = vi.fn().mockResolvedValue({ width, height })
    await expect(validateGeneratedPanorama(image, decode)).resolves.toEqual({ width, height })
    expect(decode).toHaveBeenCalledWith(expect.any(File))
    expect(decode.mock.calls[0][0].size).toBe(image.size)
  })

  it.each([[1000, 500], [8194, 4097], [4096, 2000], [4000, 2048], [NaN, 512], [1024.5, 512.25], [0, 0]])(
    'rejects incompatible decoded dimensions %s × %s without fitting them', async (width, height) => {
      await expect(validateGeneratedPanorama(image, async () => ({ width, height }))).rejects.toThrow('2:1')
    },
  )

  it('rejects empty and non-image responses before decoding', async () => {
    const decode = vi.fn()
    await expect(validateGeneratedPanorama(new Blob([], { type: 'image/jpeg' }), decode)).rejects.toThrow('non-empty')
    await expect(validateGeneratedPanorama(new Blob(['<html>error</html>'], { type: 'text/html' }), decode)).rejects.toThrow('non-empty')
    expect(decode).not.toHaveBeenCalled()
  })

  it('rejects oversized and corrupt bytes rather than trusting provider claims', async () => {
    const oversized = new Blob([new Uint8Array(MAX_GENERATED_PANORAMA_BYTES + 1)], { type: 'image/png' })
    const decode = vi.fn().mockRejectedValue(new Error('Cannot decode'))
    await expect(validateGeneratedPanorama(oversized, decode)).rejects.toThrow('too large')
    expect(decode).not.toHaveBeenCalled()
    await expect(validateGeneratedPanorama(image, decode)).rejects.toThrow('Cannot decode')
  })
})
