import { describe, expect, it, vi, afterEach } from 'vitest'
import { downloadGeneration, getGenerationHealth, getGenerationJob, startGeneration } from './generativePanorama'
import { validateGeneratedPanorama } from './validateGeneratedPanorama'
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }))
vi.mock('./validateGeneratedPanorama', () => ({ validateGeneratedPanorama: vi.fn() }))
const id = '96a2488e-bb52-4a30-ab66-836feb144244'
const queued = { id, status: 'queued', stage: 'Saved' }
afterEach(() => vi.resetAllMocks())
describe('local generative panorama client', () => {
  it('fails closed when the local service is missing or incorrectly typed', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('offline'))
    expect((await getGenerationHealth({ fetcher })).ready).toBe(false)
    fetcher.mockResolvedValue(Response.json({ ready: true, provider: 'unknown', model: 'fake' }))
    expect((await getGenerationHealth({ fetcher })).ready).toBe(false)
  })
  it('starts exactly one request with persisted ID, direction hints and no API key', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(queued))
    const prepareReference = vi.fn().mockResolvedValue({ type: 'image/jpeg', data: 'YWJj' })
    await startGeneration({ id, files: [new File(['abc'], 'photo.jpg')], prompt: 'Living room', consent: true, azimuths: [180], horizontalFovs: [40.7], fetcher, prepareReference })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('/api/generation/jobs')
    expect(JSON.parse(init.body)).toMatchObject({ id, consent: true, azimuths: [180], horizontalFovs: [40.7], photos: [{ type: 'image/jpeg', data: 'YWJj' }] })
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Bubble-Generation': '1' })
  })
  it('does not retry an ambiguous start failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('connection lost'))
    await expect(startGeneration({ id, files: [new File(['a'], 'photo.jpg')], prompt: '', consent: true, fetcher, prepareReference: async () => ({ type: 'image/jpeg', data: 'YQ==' }) })).rejects.toThrow(/reconnect/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects mismatched or unsafe camera angles before preparing or sending photos', async () => {
    const fetcher = vi.fn()
    const prepareReference = vi.fn()
    for (const horizontalFovs of [[], [NaN], [Infinity], [24], [111], [40, 60]]) {
      await expect(startGeneration({ id, files: [new File(['a'], 'a.jpg')], prompt: '', consent: true, horizontalFovs, fetcher, prepareReference })).rejects.toThrow(/camera angles/)
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(prepareReference).not.toHaveBeenCalled()
  })
  it('rejects a different job ID and preserves HTTP not-found status', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ...queued, id: 'other' }))
    await expect(getGenerationJob(id, { fetcher })).rejects.toThrow(/invalid job/)
    fetcher.mockResolvedValue(Response.json({ error: 'Not found' }, { status: 404 }))
    await expect(getGenerationJob(id, { fetcher })).rejects.toMatchObject({ status: 404 })
  })
  it('validates actual output bytes before returning a reviewable sphere', async () => {
    vi.mocked(validateGeneratedPanorama).mockResolvedValue({ width: 2048, height: 1024 })
    const fetcher = vi.fn().mockResolvedValue(new Response('image', { headers: { 'Content-Type': 'image/png' } }))
    expect(await downloadGeneration(id, { fetcher })).toMatchObject({ width: 2048, height: 1024 })
    expect(validateGeneratedPanorama).toHaveBeenCalledTimes(1)
    vi.mocked(validateGeneratedPanorama).mockRejectedValue(new Error('Not a full sphere'))
    fetcher.mockResolvedValue(new Response('flat', { headers: { 'Content-Type': 'image/png' } }))
    await expect(downloadGeneration(id, { fetcher })).rejects.toThrow('Not a full sphere')
  })
  it('does not submit a pre-cancelled draft', async () => {
    const fetcher = vi.fn()
    const controller = new AbortController()
    controller.abort()
    await expect(startGeneration({ id, files: [new File(['a'], 'a.jpg')], prompt: '', consent: true, fetcher, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
