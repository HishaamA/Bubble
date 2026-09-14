import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGenerativeCaptureStore, createMemoryGenerativeCaptureStore, generativeCaptureDatabaseName,
  parseGenerativeCaptureDraft, type GenerativeCaptureDraft } from './generativeCaptureStore'

function draft(ownerKey = 'clerk:one'): GenerativeCaptureDraft {
  return { version: 1, id: 'draft-one', ownerKey, createdAt: '2026-09-09T12:00:00Z', updatedAt: '2026-09-09T12:00:00Z',
    photos: [{ id: 'photo-one', name: 'room.jpg', original: new Blob(['original'], { type: 'image/jpeg' }),
      image: new Blob(['prepared'], { type: 'image/jpeg' }), thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }),
      width: 1600, height: 1200, origin: 'camera', azimuth: 0 }], prompt: 'Room', caption: '', annotations: [] }
}

afterEach(() => vi.unstubAllGlobals())

describe('durable generative photo drafts', () => {
  it('isolates authenticated/demo accounts and refuses an empty owner', () => {
    expect(generativeCaptureDatabaseName('clerk:a/b')).toBe('bubble-generative-capture:clerk%3Aa%2Fb')
    expect(generativeCaptureDatabaseName('demo:a/b')).not.toBe(generativeCaptureDatabaseName('clerk:a/b'))
    expect(() => generativeCaptureDatabaseName(' ')).toThrow(/sign in/i)
    expect(parseGenerativeCaptureDraft(draft(), 'clerk:two')).toBeNull()
  })
  it('keeps original bytes and independent metadata instead of process-local URLs', async () => {
    const store = createMemoryGenerativeCaptureStore('clerk:one')
    const input = draft()
    await store.save(input)
    input.photos[0].name = 'changed.jpg'
    const stored = (await store.list())[0]
    expect(stored.photos[0].name).toBe('room.jpg')
    expect(stored.photos[0].original).toBe(input.photos[0].original)
    stored.photos[0].azimuth = 270
    expect((await store.list())[0].photos[0].azimuth).toBe(0)
    expect(parseGenerativeCaptureDraft({ ...draft(), photos: [{ ...draft().photos[0], image: 'blob:temporary' }] }, 'clerk:one')).toBeNull()
  })
  it('rejects a fifth photo, impossible directions, and another owner at write time', async () => {
    const input = draft()
    expect(parseGenerativeCaptureDraft({ ...input, photos: Array(5).fill(input.photos[0]) }, input.ownerKey)).toBeNull()
    expect(parseGenerativeCaptureDraft({ ...input, photos: [{ ...input.photos[0], azimuth: 45 }] }, input.ownerKey)).toBeNull()
    await expect(createMemoryGenerativeCaptureStore('clerk:two').save(input)).rejects.toThrow(/another account/i)
  })
  it('keeps old drafts without estimates and defensively copies optional local estimates', async () => {
    const old = draft()
    expect(parseGenerativeCaptureDraft(old, old.ownerKey)?.photos[0].fieldOfView).toBeUndefined()
    const store = createMemoryGenerativeCaptureStore(old.ownerKey)
    old.photos[0].fieldOfView = { horizontalFovDegrees: 40.6, source: 'exif-35mm-equivalent', estimated: true }
    await store.save(old)
    old.photos[0].fieldOfView.horizontalFovDegrees = 99
    const firstRead = (await store.list())[0]
    expect(firstRead.photos[0].fieldOfView).toEqual({ horizontalFovDegrees: 40.6, source: 'exif-35mm-equivalent', estimated: true })
    firstRead.photos[0].fieldOfView!.horizontalFovDegrees = 50
    expect((await store.list())[0].photos[0].fieldOfView?.horizontalFovDegrees).toBe(40.6)
  })
  it('drops invalid optional estimates without losing the originals or completed result', () => {
    const source = draft()
    const result = { file: new Blob(['sphere'], { type: 'image/jpeg' }), width: 2048, height: 1024,
      provenance: { kind: 'ai-reconstruction', provider: 'local', model: 'local-model', referenceCount: 1, generatedAt: '2026-09-09T12:01:00Z' } }
    for (const fieldOfView of [
      { horizontalFovDegrees: 111, source: 'diagonal-fallback', estimated: true },
      { horizontalFovDegrees: 24, source: 'diagonal-fallback', estimated: true },
      { horizontalFovDegrees: Number.NaN, source: 'diagonal-fallback', estimated: true },
      { horizontalFovDegrees: 40, source: 'gps', estimated: true },
      { horizontalFovDegrees: 40, source: 'diagonal-fallback', estimated: false },
    ]) {
      const restored = parseGenerativeCaptureDraft({ ...source, result, photos: [{ ...source.photos[0], fieldOfView }] }, source.ownerKey)
      expect(restored?.photos[0].fieldOfView).toBeUndefined()
      expect(restored?.photos[0].original).toBe(source.photos[0].original)
      expect(restored?.result?.file).toBe(result.file)
    }
  })
  it('retains completed results and provenance independently of later saves', async () => {
    const input: GenerativeCaptureDraft = { ...draft(), job: { id: 'job-one', status: 'completed', stage: 'Done' }, result: {
      file: new Blob(['sphere'], { type: 'image/jpeg' }), width: 2048, height: 1024,
      provenance: { kind: 'ai-reconstruction', provider: 'local', model: 'local-model-v1', referenceCount: 1, generatedAt: '2026-09-09T12:01:00Z' },
    } }
    const store = createMemoryGenerativeCaptureStore(input.ownerKey)
    await store.save(input)
    input.result!.provenance.model = 'changed'
    expect((await store.list())[0].result?.provenance.model).toBe('local-model-v1')
    expect(parseGenerativeCaptureDraft({ ...input, result: { ...input.result, width: 1920 } }, input.ownerKey)).toBeNull()
    expect(parseGenerativeCaptureDraft({ ...input, result: { ...input.result, file: 'https://temporary/result.jpg' } }, input.ownerKey)).toBeNull()
  })
  it('fails clearly when durable storage is unavailable instead of pretending a memory save is durable', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const store = createGenerativeCaptureStore('clerk:one')
    await expect(store.save(draft())).rejects.toThrow(/durable photo storage is unavailable/i)
    await expect(store.list()).rejects.toThrow(/durable photo storage is unavailable/i)
  })
  it('waits for the IndexedDB transaction commit and propagates a failed transaction', async () => {
    const transaction = { objectStore: () => ({ put: vi.fn() }), oncomplete: undefined as (() => void) | undefined,
      onerror: undefined as (() => void) | undefined, onabort: undefined as (() => void) | undefined, error: null as Error | null }
    const database = { transaction: () => transaction, close: vi.fn() }
    const factory = { open: vi.fn(() => {
      const request = { result: database, onsuccess: undefined as (() => void) | undefined }
      queueMicrotask(() => request.onsuccess?.())
      return request
    }) } as unknown as IDBFactory
    const store = createGenerativeCaptureStore('clerk:one', factory)
    let saved = false
    const saving = store.save(draft()).then(() => { saved = true })
    await vi.waitFor(() => expect(transaction.oncomplete).toBeTypeOf('function'))
    expect(saved).toBe(false)
    transaction.oncomplete!()
    await saving
    expect(saved).toBe(true)
    const failure = store.save(draft())
    const assertion = expect(failure).rejects.toThrow('Storage full')
    await Promise.resolve()
    await Promise.resolve()
    transaction.error = new Error('Storage full')
    transaction.onabort!()
    await assertion
    expect(database.close).toHaveBeenCalledTimes(2)
  })
})
