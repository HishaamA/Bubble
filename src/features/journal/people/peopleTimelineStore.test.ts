import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emptyPeopleTimelineState,
  loadPeopleTimelineState,
  parsePeopleTimelineState,
  savePeopleTimelineState,
} from './peopleTimelineStore'
import {
  FACE_MODEL_REVISION,
  FACE_SCAN_REVISION,
  type PeopleTimelineState,
} from './types'

function indexedDatabase(initialValue?: unknown) {
  type Row = { key: IDBValidKey; value: unknown }
  type Request = { result?: unknown; readyState: 'pending' | 'done'; onsuccess?: () => void }
  const records = new Map<string, Map<string, Row>>([['account-state', new Map()]])
  let legacy = initialValue
  let failNextWrite = false
  let version = 1
  const put = vi.fn()
  const scanPut = vi.fn()
  const scanDelete = vi.fn()
  const scanGetAll = vi.fn()
  vi.stubGlobal('IDBKeyRange', {
    bound: (lower: IDBValidKey, upper: IDBValidKey) => ({ lower, upper }),
  })
  const namespaceRows = (store: Map<string, Row>, range: { lower: string[] }) => [...store.values()]
    .filter(({ key }) => Array.isArray(key) && key[0] === range.lower[0])
    .sort((left, right) => JSON.stringify(left.key).localeCompare(JSON.stringify(right.key)))
  const factory = {
    open: vi.fn((_name: string, requestedVersion: number) => {
      const request: Record<string, unknown> = {}
      queueMicrotask(() => {
        const database = {
          objectStoreNames: { contains: (name: string) => records.has(name) },
          createObjectStore: (name: string) => { records.set(name, new Map()) },
          transaction: (_storeNames: string | string[], mode: IDBTransactionMode) => {
            const staged = new Map([...records].map(([name, rows]) => [name, new Map(rows)]))
            let pending = 0
            let finished = false
            const fails = mode === 'readwrite' && failNextWrite
            if (fails) failNextWrite = false
            const transaction: {
              error?: Error; oncomplete?: () => void; onabort?: () => void;
              abort: () => void; objectStore?: (name: string) => unknown
            } = {
              abort: () => {
                if (finished) return
                finished = true
                transaction.error = new Error('Transaction aborted')
                queueMicrotask(() => transaction.onabort?.())
              },
            }
            const complete = () => {
              queueMicrotask(() => {
                if (finished || pending) return
                if (fails) { transaction.abort(); return }
                finished = true
                if (mode === 'readwrite') {
                  for (const [name, rows] of staged) records.set(name, rows)
                }
                transaction.oncomplete?.()
              })
            }
            const operation = (run: () => unknown) => {
              const result: Request = { readyState: 'pending' }
              pending += 1
              queueMicrotask(() => {
                if (finished) return
                result.result = structuredClone(run())
                result.readyState = 'done'
                result.onsuccess?.()
                pending -= 1
                complete()
              })
              return result
            }
            transaction.objectStore = (name) => {
              const rows = staged.get(name)!
              return {
                get: (key: IDBValidKey) => operation(() => {
                  if (name === 'account-state' && legacy !== undefined) {
                    const row = { key, value: structuredClone(legacy) }
                    rows.set(JSON.stringify(key), row)
                    records.get(name)!.set(JSON.stringify(key), row)
                    legacy = undefined
                  }
                  return rows.get(JSON.stringify(key))?.value
                }),
                getAllKeys: (range: { lower: string[] }) => operation(() => namespaceRows(rows, range).map(({ key }) => key)),
                getAll: (range: { lower: string[] }) => {
                  scanGetAll(range)
                  return operation(() => namespaceRows(rows, range).map(({ value }) => value))
                },
                put: (value: unknown, key: IDBValidKey) => {
                  if (name === 'account-state') put(value, key)
                  else scanPut(value, key)
                  const stored = structuredClone(value)
                  return operation(() => { rows.set(JSON.stringify(key), { key, value: stored }); return key })
                },
                delete: (key: IDBValidKey) => {
                  scanDelete(key)
                  return operation(() => rows.delete(JSON.stringify(key)))
                },
              }
            }
            complete()
            return transaction
          },
          close: () => undefined,
        }
        request.result = database
        if (requestedVersion > version) {
          const upgrade = request.onupgradeneeded
          if (typeof upgrade === 'function') upgrade()
          version = requestedVersion
        }
        const onsuccess = request.onsuccess
        if (typeof onsuccess === 'function') onsuccess()
      })
      return request
    }),
  }

  return {
    factory,
    put,
    scanPut,
    scanDelete,
    scanGetAll,
    failNextWrite: () => { failNextWrite = true },
    storedValue: (namespace: string) => records.get('account-state')?.get(JSON.stringify(namespace))?.value,
    scanRows: (namespace: string) => Object.fromEntries(namespaceRows(records.get('photo-face-scans')!, { lower: [namespace] })
      .map(({ key, value }) => [(key as string[])[1], value])),
    overwriteMetadata: (namespace: string, value: unknown) => records.get('account-state')!.set(JSON.stringify(namespace), {
      key: namespace, value: structuredClone(value),
    }),
    overwriteScan: (namespace: string, photoKey: string, value: unknown) => records.get('photo-face-scans')!
      .set(JSON.stringify([namespace, photoKey]), { key: [namespace, photoKey], value: structuredClone(value) }),
  }
}

function fallbackKey(namespace: string) {
  return `kinsphere.peopleTimeline.v1:${encodeURIComponent(namespace)}`
}

function stateWithBiometrics(): PeopleTimelineState {
  return {
    ...emptyPeopleTimelineState(),
    people: [{
      id: 'maya',
      name: 'Maya',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
    assignments: [{
      photoKey: 'photo:portrait',
      personId: 'maya',
      source: 'manual',
      confirmedAt: '2026-01-02T00:00:00.000Z',
    }],
    dateOverrides: {
      'photo:portrait': { precision: 'year', value: '1998' },
    },
    faceScans: {
      'photo:portrait': {
        scannedAt: '2026-01-02T00:00:00.000Z',
        faces: [{
          id: 'face-maya',
          embedding: [1, 0],
          box: [0.1, 0.1, 0.5, 0.7],
          detectorScore: 0.99,
          descriptorScore: 0.98,
          quality: 0.9,
        }],
      },
    },
    faceProfiles: {
      maya: {
        references: [{
          id: 'enrollment-maya',
          embedding: [0.99, 0.01],
          source: 'enrollment',
          createdAt: '2026-01-01T00:00:00.000Z',
          quality: 0.95,
        }],
      },
    },
    dismissedSuggestions: [{
      photoKey: 'photo:other',
      personId: 'maya',
      dismissedAt: '2026-01-03T00:00:00.000Z',
    }],
  }
}

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('people timeline persistence', () => {
  it('preserves bounded face-pixel measurements and legacy scans without a revision bump', async () => {
    const state = stateWithBiometrics()
    const legacy = state.faceScans['photo:portrait'].faces[0]
    state.faceScans['photo:measured'] = {
      scannedAt: '2026-09-13T12:00:00Z',
      faces: [{ ...legacy, id: 'face-measured', minFacePixels: 83.5 },
        { ...legacy, id: 'face-upper-bound', minFacePixels: 1280 }],
    }
    const database = indexedDatabase()
    vi.stubGlobal('indexedDB', database.factory)
    expect(await savePeopleTimelineState('family:face-pixels', state)).toBe(true)
    const loaded = await loadPeopleTimelineState('family:face-pixels')
    expect(loaded.faceScans['photo:measured'].faces.map(({ minFacePixels }) => minFacePixels))
      .toEqual([83.5, 1280])
    expect(loaded.faceScans['photo:portrait']).toEqual(state.faceScans['photo:portrait'])
    expect(loaded.faceScans['photo:portrait'].faces[0]).not.toHaveProperty('minFacePixels')
    expect(loaded.faceScanRevision).toBe(state.faceScanRevision)
    expect(loaded.assignments).toEqual(state.assignments)
    expect(loaded.faceProfiles).toEqual(state.faceProfiles)
  })

  it.each([0, -1, 1280.01, Number.NaN, Number.POSITIVE_INFINITY, null, '100'])
    ('retains faces but marks invalid explicit size %s ineligible instead of treating it as legacy', (invalid) => {
      const state = stateWithBiometrics()
      const original = state.faceScans['photo:portrait'].faces[0]
      const parsed = parsePeopleTimelineState({
        ...state,
        faceScans: { 'photo:portrait': { scannedAt: '2026-09-13T12:00:00Z',
          faces: [{ ...original, minFacePixels: invalid }],
        } },
      })
      expect(parsed.faceScans['photo:portrait'].faces).toEqual([{ ...original, minFacePixels: 0 }])
      expect(parsed.assignments).toEqual(state.assignments)
      expect(parsed.faceProfiles).toEqual(state.faceProfiles)
      expect(parsePeopleTimelineState(parsed).faceScans).toEqual(parsed.faceScans)
    })

  it('hydrates all 4,697 completed gallery scans including photos with no faces', async () => {
    const state: PeopleTimelineState = {
      ...emptyPeopleTimelineState(),
      faceScans: Object.fromEntries(Array.from({ length: 4_697 }, (_, index) => [
        `gallery:android:${index}`,
        { scannedAt: '2026-09-13T12:00:00.000Z', faces: [] },
      ])),
    }
    const database = indexedDatabase(state)
    vi.stubGlobal('indexedDB', database.factory)

    const loaded = await loadPeopleTimelineState('family:full-gallery')

    expect(Object.keys(loaded.faceScans)).toHaveLength(4_697)
    expect(loaded).toEqual(state)
    expect(loaded.faceScans['gallery:android:4696'].faces).toEqual([])
    expect(loaded.faceScans['gallery:android:0']).not.toBe(state.faceScans['gallery:android:0'])
    expect(loaded.faceScans['gallery:android:0'].faces).not.toBe(state.faceScans['gallery:android:0'].faces)
    expect(window.localStorage.getItem(fallbackKey('family:full-gallery'))).toBeNull()
    expect(database.put).not.toHaveBeenCalled()
  })

  it('does not repeatedly enumerate the growing scan map while hydrating a gallery', () => {
    const state = {
      ...emptyPeopleTimelineState(),
      faceScans: Object.fromEntries(Array.from({ length: 4_697 }, (_, index) => [
        `gallery:android:${index}`,
        { scannedAt: '2026-09-13T12:00:00.000Z', faces: [] },
      ])),
    }
    const keys = vi.spyOn(Object, 'keys')
    const parsed = parsePeopleTimelineState(state)
    const scanMapEnumerations = keys.mock.calls.filter(([value]) => value === parsed.faceScans).length
    keys.mockRestore()

    // Count operations rather than wall time: this fails the old O(n²) loop
    // without making phone-speed assumptions or flaky timing assertions.
    expect(scanMapEnumerations).toBeLessThanOrEqual(1)
    expect(Object.keys(parsed.faceScans)).toHaveLength(4_697)
  })

  it('still caps accepted scans at 20,000 and does not count rejected records', () => {
    const scannedAt = '2026-09-13T12:00:00.000Z'
    const scans = Object.fromEntries(Array.from({ length: 20_002 }, (_, index) => [
      `gallery:android:${index}`,
      { scannedAt, faces: [] },
    ]))
    const parsed = parsePeopleTimelineState({
      ...emptyPeopleTimelineState(),
      faceScans: {
        '': { scannedAt, faces: [] },
        'invalid:missing-time': { faces: [] },
        'invalid:missing-faces': { scannedAt },
        'invalid:wrong-faces': { scannedAt, faces: null },
        'invalid:wrong-time': { scannedAt: 10, faces: [] },
        ...scans,
      },
    })

    expect(Object.keys(parsed.faceScans)).toHaveLength(20_000)
    expect(parsed.faceScans['gallery:android:19999']).toEqual({ scannedAt, faces: [] })
    expect(parsed.faceScans['gallery:android:20000']).toBeUndefined()
    expect(parsed.faceScans['gallery:android:20001']).toBeUndefined()
    expect(parsed.faceScans['invalid:missing-time']).toBeUndefined()
    expect(parsed.version).toBe(4)
    expect(parsed.faceModelRevision).toBe(FACE_MODEL_REVISION)
    expect(parsed.faceScanRevision).toBe(FACE_SCAN_REVISION)
  })

  it('migrates v3 enrollment while invalidating old photo scans', () => {
    const parsed = parsePeopleTimelineState({
      version: 1,
      faceModelRevision: FACE_MODEL_REVISION,
      people: [
        { id: 'maya', name: 'Maya', createdAt: '2026-01-01' },
        { id: 'blank', name: '   ', createdAt: '2026-01-01' },
      ],
      assignments: [
        { photoKey: 'photo:one', personId: 'maya', source: 'manual', confirmedAt: '2026-01-02' },
        { photoKey: 'photo:one', personId: 'unknown', source: 'manual', confirmedAt: '2026-01-02' },
        { photoKey: 'photo:one', personId: 'maya', source: 'guessed', confirmedAt: '2026-01-02' },
      ],
      dateOverrides: {
        'photo:one': { precision: 'year', value: '2004' },
        'photo:bad': { precision: 'month', value: '2004-02' },
      },
      embeddings: {
        'photo:one': [[1, 0], [], [Number.NaN, 1]],
      },
      referenceEmbeddings: {
        maya: [1, 0],
        unknown: [0, 1],
        blank: [0.5, Number.POSITIVE_INFINITY],
      },
      dismissedSuggestions: [
        { photoKey: 'photo:two', personId: 'maya', dismissedAt: '2026-01-03' },
        { photoKey: 'photo:two', personId: 'unknown', dismissedAt: '2026-01-03' },
      ],
    })

    expect(parsed).toEqual({
      version: 4,
      faceModelRevision: FACE_MODEL_REVISION,
      faceScanRevision: FACE_SCAN_REVISION,
      people: [{ id: 'maya', name: 'Maya', createdAt: '2026-01-01' }],
      assignments: [{
        photoKey: 'photo:one',
        personId: 'maya',
        source: 'manual',
        confirmedAt: '2026-01-02',
      }],
      dateOverrides: {
        'photo:one': { precision: 'year', value: '2004' },
      },
      faceScans: {},
      faceProfiles: {
        maya: {
          references: [{
            id: 'legacy-enrollment:maya:0',
            embedding: [1, 0],
            source: 'enrollment',
            createdAt: '2026-01-01',
          }],
        },
      },
      dismissedSuggestions: [{
        photoKey: 'photo:two',
        personId: 'maya',
        dismissedAt: '2026-01-03',
      }],
    })
  })

  it('retains profiles but rescans photos when the scan revision changes', () => {
    const current = stateWithBiometrics()
    const parsed = parsePeopleTimelineState({
      ...current,
      faceScanRevision: 'rotation-only-v1',
      assignments: [
        ...current.assignments.map((assignment) => ({
          ...assignment,
          faceId: 'face-maya',
        })),
        {
          photoKey: 'photo:auto',
          personId: 'maya',
          faceId: 'face-maya',
          source: 'face-suggestion',
          confirmedAt: '2026-01-04T00:00:00.000Z',
        },
      ],
      dismissedSuggestions: current.dismissedSuggestions.map((dismissal) => ({
        ...dismissal,
        faceId: 'face-maya',
      })),
    })

    expect(parsed).toMatchObject({
      version: 4,
      faceModelRevision: FACE_MODEL_REVISION,
      faceScanRevision: FACE_SCAN_REVISION,
      people: current.people,
      dateOverrides: current.dateOverrides,
      faceScans: {},
      faceProfiles: current.faceProfiles,
      assignments: [{
        photoKey: 'photo:portrait',
        personId: 'maya',
        source: 'manual',
        confirmedAt: '2026-01-02T00:00:00.000Z',
      }],
      dismissedSuggestions: [{
        photoKey: 'photo:other',
        personId: 'maya',
        dismissedAt: '2026-01-03T00:00:00.000Z',
      }],
    })
  })

  it('normalizes current face records and drops malformed or dangling data', () => {
    const current = stateWithBiometrics()
    const parsed = parsePeopleTimelineState({
      ...current,
      faceScans: {
        ...current.faceScans,
        'photo:invalid': {
          scannedAt: '2026-01-04T00:00:00.000Z',
          faces: [{
            id: 'outside-photo',
            embedding: [1, 0],
            box: [0.8, 0.2, 0.4, 0.5],
            detectorScore: 0.9,
            descriptorScore: 0.9,
            quality: 0.9,
          }],
        },
      },
      faceProfiles: {
        ...current.faceProfiles,
        unknown: current.faceProfiles.maya,
      },
      assignments: [{
        ...current.assignments[0],
        faceId: 'face-maya',
      }],
      dismissedSuggestions: [{
        ...current.dismissedSuggestions[0],
        faceId: 'missing-face',
      }],
    })

    expect(parsed.faceScans['photo:portrait']).toEqual(
      current.faceScans['photo:portrait'],
    )
    expect(parsed.faceScans['photo:invalid']).toEqual({
      scannedAt: '2026-01-04T00:00:00.000Z',
      faces: [],
    })
    expect(parsed.faceProfiles).toEqual(current.faceProfiles)
    expect(parsed.assignments[0]?.faceId).toBe('face-maya')
    expect(parsed.dismissedSuggestions[0]?.faceId).toBeUndefined()
  })

  it('invalidates legacy-model vectors but retains people and manual metadata', () => {
    const current = stateWithBiometrics()
    const parsed = parsePeopleTimelineState({
      ...current,
      version: 2,
      faceModelRevision: 'human-faceres-legacy',
    })

    expect(parsed).toMatchObject({
      version: 4,
      faceModelRevision: FACE_MODEL_REVISION,
      faceScanRevision: FACE_SCAN_REVISION,
      people: current.people,
      assignments: current.assignments,
      dateOverrides: current.dateOverrides,
      faceScans: {},
      faceProfiles: {},
      dismissedSuggestions: current.dismissedSuggestions,
    })
  })

  it('stores only metadata in localStorage and never claims vectors were durable', async () => {
    const namespace = 'family:metadata-only'
    vi.stubGlobal('indexedDB', undefined)

    await expect(
      savePeopleTimelineState(namespace, stateWithBiometrics()),
    ).resolves.toBe(false)

    const stored = JSON.parse(
      window.localStorage.getItem(fallbackKey(namespace)) ?? 'null',
    )
    expect(stored).toMatchObject({
      people: [expect.objectContaining({ id: 'maya' })],
      assignments: [expect.objectContaining({
        photoKey: 'photo:portrait',
        personId: 'maya',
        source: 'manual',
      })],
      dateOverrides: {
        'photo:portrait': { precision: 'year', value: '1998' },
      },
      faceScans: {},
      faceProfiles: {},
    })
  })

  it('does not reload current or legacy biometric vectors from localStorage', async () => {
    const namespace = 'family:legacy-fallback'
    const state = stateWithBiometrics()
    window.localStorage.setItem(fallbackKey(namespace), JSON.stringify({
      ...state,
      embeddings: { 'photo:legacy': [[1, 0]] },
      referenceEmbeddings: { maya: [1, 0] },
    }))
    vi.stubGlobal('indexedDB', undefined)

    const loaded = await loadPeopleTimelineState(namespace)

    expect(loaded).toMatchObject({
      people: state.people,
      assignments: state.assignments,
      dateOverrides: state.dateOverrides,
      faceScans: {},
      faceProfiles: {},
    })
    expect(JSON.parse(
      window.localStorage.getItem(fallbackKey(namespace)) ?? 'null',
    )).toMatchObject({
      faceScans: {},
      faceProfiles: {},
    })
    const rewritten = JSON.parse(
      window.localStorage.getItem(fallbackKey(namespace)) ?? 'null',
    )
    expect(rewritten).not.toHaveProperty('embeddings')
    expect(rewritten).not.toHaveProperty('referenceEmbeddings')
  })

  it('retains enrollment and photo vectors through IndexedDB', async () => {
    const namespace = 'family:indexed-vectors'
    const database = indexedDatabase()
    const state = stateWithBiometrics()
    vi.stubGlobal('indexedDB', database.factory)

    await expect(savePeopleTimelineState(namespace, state)).resolves.toBe(true)
    expect(database.put).toHaveBeenCalledWith(expect.objectContaining({ ...state, faceScans: {},
      faceScanStorage: { version: 1, writeId: expect.any(String) },
    }), namespace)
    expect(database.storedValue(namespace)).toMatchObject({ ...state, faceScans: {} })
    expect(database.scanRows(namespace)).toEqual(state.faceScans)
    await expect(loadPeopleTimelineState(namespace)).resolves.toEqual(state)
  })

  it('writes only the next eight rows after a 4,697-photo checkpoint, without reading old vectors', async () => {
    const namespace = 'family:incremental-gallery'
    const database = indexedDatabase()
    vi.stubGlobal('indexedDB', database.factory)
    const state = { ...stateWithBiometrics(), faceScans: Object.fromEntries(
      Array.from({ length: 4_697 }, (_, index) => [`photo:${index}`, {
        scannedAt: '2026-09-14T00:00:00Z', faces: [],
      }]),
    ) }
    expect(await savePeopleTimelineState(namespace, state)).toBe(true)
    expect(database.scanPut).toHaveBeenCalledTimes(4_697)
    database.scanPut.mockClear()
    const additions = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`photo:new-${index}`, {
      scannedAt: '2026-09-14T00:01:00Z', faces: [],
    }]))
    const next = { ...state, faceScans: { ...state.faceScans, ...additions } }

    expect(await savePeopleTimelineState(namespace, next)).toBe(true)

    expect(database.scanPut).toHaveBeenCalledTimes(8)
    expect(database.scanPut.mock.calls.map(([, key]) => key)).toEqual(
      Object.keys(additions).map((key) => [namespace, key]),
    )
    expect(database.scanGetAll).not.toHaveBeenCalled()
    expect(database.put).toHaveBeenCalledTimes(2)
    expect(database.put.mock.calls.every(([metadata]) => Object.keys(metadata.faceScans).length === 0)).toBe(true)
    expect(Object.keys(database.scanRows(namespace))).toHaveLength(4_705)
    database.scanPut.mockClear()
    const metadataEdit = { ...next, dateOverrides: { 'photo:1': { precision: 'year' as const, value: '2000' } } }
    expect(await savePeopleTimelineState(namespace, metadataEdit)).toBe(true)
    expect(database.scanPut).not.toHaveBeenCalled()
    expect(database.scanGetAll).not.toHaveBeenCalled()
    expect(await loadPeopleTimelineState(namespace)).toEqual(metadataEdit)
  })

  it('reuses hydrated row identities and writes a replaced scan without rewriting its neighbors', async () => {
    const namespace = 'family:hydrated-incremental'
    const database = indexedDatabase()
    vi.stubGlobal('indexedDB', database.factory)
    const state = stateWithBiometrics()
    state.faceScans['photo:neighbor'] = { scannedAt: '2026-09-14T00:00:00Z', faces: [] }
    await savePeopleTimelineState(namespace, state)
    const hydrated = await loadPeopleTimelineState(namespace)
    const replacement = { ...hydrated.faceScans['photo:portrait'], scannedAt: '2026-09-14T01:00:00Z' }
    const next = { ...hydrated, faceScans: { ...hydrated.faceScans, 'photo:portrait': replacement } }
    database.scanPut.mockClear()
    database.scanGetAll.mockClear()

    expect(await savePeopleTimelineState(namespace, next)).toBe(true)

    expect(database.scanPut).toHaveBeenCalledExactlyOnceWith(replacement, [namespace, 'photo:portrait'])
    expect(database.scanGetAll).not.toHaveBeenCalled()
    expect(await loadPeopleTimelineState(namespace)).toEqual(next)
  })

  it('migrates an existing single-record snapshot atomically without changing revisions or requiring rescanning', async () => {
    const namespace = 'family:legacy-migration'
    const original = stateWithBiometrics()
    const database = indexedDatabase(original)
    vi.stubGlobal('indexedDB', database.factory)
    const loaded = await loadPeopleTimelineState(namespace)
    expect(loaded).toEqual(original)
    expect(database.put).not.toHaveBeenCalled()
    expect(database.scanPut).not.toHaveBeenCalled()
    expect(database.factory.open).toHaveBeenCalledWith('kinsphere-people-timeline', 2)
    const next = { ...loaded, faceScans: { ...loaded.faceScans,
      'photo:new': { scannedAt: '2026-09-14T00:00:00Z', faces: [] },
    } }

    expect(await savePeopleTimelineState(namespace, next)).toBe(true)

    expect(database.scanRows(namespace)).toEqual(next.faceScans)
    expect(database.storedValue(namespace)).toMatchObject({
      faceScans: {}, faceScanStorage: { version: 1, writeId: expect.any(String) },
      faceModelRevision: original.faceModelRevision, faceScanRevision: original.faceScanRevision,
      faceProfiles: original.faceProfiles, assignments: original.assignments, people: original.people,
    })
    expect(await loadPeopleTimelineState(namespace)).toEqual(next)
  })

  it('rolls back a failed migration completely and retries the same row references', async () => {
    const namespace = 'family:failed-migration'
    const original = stateWithBiometrics()
    const database = indexedDatabase(original)
    vi.stubGlobal('indexedDB', database.factory)
    const loaded = await loadPeopleTimelineState(namespace)
    const next = { ...loaded, faceScans: { ...loaded.faceScans,
      'photo:new': { scannedAt: '2026-09-14T00:00:00Z', faces: [] },
    } }
    database.failNextWrite()

    expect(await savePeopleTimelineState(namespace, next)).toBe(false)

    expect(database.storedValue(namespace)).toEqual(original)
    expect(database.scanRows(namespace)).toEqual({})
    expect(JSON.parse(window.localStorage.getItem(fallbackKey(namespace))!)).toMatchObject({ faceScans: {}, faceProfiles: {} })
    database.scanPut.mockClear()
    expect(await savePeopleTimelineState(namespace, next)).toBe(true)
    expect(database.scanPut).toHaveBeenCalledTimes(2)
    expect(window.localStorage.getItem(fallbackKey(namespace))).toBeNull()
    expect(await loadPeopleTimelineState(namespace)).toEqual(next)
  })

  it('does not mark a failed incremental row durable and retries it before advancing storage', async () => {
    const namespace = 'family:failed-incremental'
    const database = indexedDatabase()
    vi.stubGlobal('indexedDB', database.factory)
    const original = stateWithBiometrics()
    await savePeopleTimelineState(namespace, original)
    const previousMetadata = database.storedValue(namespace)
    const addition = { scannedAt: '2026-09-14T00:00:00Z', faces: [] }
    const next = { ...original, faceScans: { ...original.faceScans, 'photo:new': addition } }
    database.scanPut.mockClear()
    database.failNextWrite()

    expect(await savePeopleTimelineState(namespace, next)).toBe(false)
    expect(database.storedValue(namespace)).toEqual(previousMetadata)
    expect(database.scanRows(namespace)).toEqual(original.faceScans)
    expect(await savePeopleTimelineState(namespace, next)).toBe(true)

    expect(database.scanPut.mock.calls).toEqual([
      [addition, [namespace, 'photo:new']], [addition, [namespace, 'photo:new']],
    ])
    expect(await loadPeopleTimelineState(namespace)).toEqual(next)
  })

  it('deletes removed rows and clears face data without changing another namespace or manual metadata', async () => {
    const firstNamespace = 'member:one/family'
    const secondNamespace = 'member:one/family:other'
    const database = indexedDatabase()
    vi.stubGlobal('indexedDB', database.factory)
    const original = stateWithBiometrics()
    await savePeopleTimelineState(firstNamespace, original)
    await savePeopleTimelineState(secondNamespace, original)
    const first = await loadPeopleTimelineState(firstNamespace)
    const removed = { ...first, faceScans: {} }
    database.scanPut.mockClear()
    expect(await savePeopleTimelineState(firstNamespace, removed)).toBe(true)
    expect(database.scanDelete).toHaveBeenCalledExactlyOnceWith([firstNamespace, 'photo:portrait'])
    expect(database.scanPut).not.toHaveBeenCalled()
    expect(database.scanRows(firstNamespace)).toEqual({})
    const cleared = { ...removed, faceProfiles: {}, dismissedSuggestions: [] }
    expect(await savePeopleTimelineState(firstNamespace, cleared)).toBe(true)
    expect(await loadPeopleTimelineState(firstNamespace)).toEqual(cleared)
    expect(await loadPeopleTimelineState(secondNamespace)).toEqual(original)
  })

  it('keeps a failed clear hidden by the metadata-only fallback until its row deletion succeeds', async () => {
    const namespace = 'family:clear-retry'
    const database = indexedDatabase()
    vi.stubGlobal('indexedDB', database.factory)
    const original = stateWithBiometrics()
    await savePeopleTimelineState(namespace, original)
    const cleared = { ...original, faceScans: {}, faceProfiles: {} }
    database.failNextWrite()

    // Preserve the existing fallback contract: a metadata-only clear takes
    // precedence over an older biometric-capable database snapshot.
    expect(await savePeopleTimelineState(namespace, cleared)).toBe(true)
    expect(database.scanRows(namespace)).toEqual(original.faceScans)
    expect(await loadPeopleTimelineState(namespace)).toEqual(cleared)
    expect(await savePeopleTimelineState(namespace, cleared)).toBe(true)
    expect(database.scanRows(namespace)).toEqual({})
    expect(window.localStorage.getItem(fallbackKey(namespace))).toBeNull()
    expect(await loadPeopleTimelineState(namespace)).toEqual(cleared)
  })

  it.each(['faceScanRevision', 'faceModelRevision'] as const)
    ('normalizes an old split %s and removes invalidated rows on its next save', async (revision) => {
      const namespace = `family:split-revision:${revision}`
      const database = indexedDatabase()
      vi.stubGlobal('indexedDB', database.factory)
      const original = stateWithBiometrics()
      await savePeopleTimelineState(namespace, original)
      database.overwriteMetadata(namespace, { ...database.storedValue(namespace) as object, [revision]: 'previous-model-or-pipeline' })
      const loaded = await loadPeopleTimelineState(namespace)

      expect(loaded.faceScans).toEqual({})
      expect(loaded.faceProfiles).toEqual(revision === 'faceModelRevision' ? {} : original.faceProfiles)
      expect(loaded.assignments).toEqual(original.assignments)
      expect(loaded.people).toEqual(original.people)
      expect(await savePeopleTimelineState(namespace, loaded)).toBe(true)
      expect(database.scanRows(namespace)).toEqual({})
      expect(await loadPeopleTimelineState(namespace)).toEqual(loaded)
    })

  it('rewrites parser-repaired rows instead of treating removed malformed faces as still durable', async () => {
    const namespace = 'family:repair-split-row'
    const database = indexedDatabase()
    vi.stubGlobal('indexedDB', database.factory)
    const original = stateWithBiometrics()
    await savePeopleTimelineState(namespace, original)
    const raw = original.faceScans['photo:portrait']
    database.overwriteScan(namespace, 'photo:portrait', { ...raw, faces: [...raw.faces,
      { ...raw.faces[0], id: 'invalid-private-vector', embedding: [Number.NaN] },
    ] })
    const loaded = await loadPeopleTimelineState(namespace)
    database.scanPut.mockClear()

    expect(loaded.faceScans).toEqual(original.faceScans)
    expect(await savePeopleTimelineState(namespace, loaded)).toBe(true)

    expect(database.scanPut).toHaveBeenCalledExactlyOnceWith(loaded.faceScans['photo:portrait'], [namespace, 'photo:portrait'])
    expect(database.scanRows(namespace)).toEqual(original.faceScans)
  })

  it('does not trust a stale identity cache after another committed writer changes the marker', async () => {
    const namespace = 'family:external-writer'
    const database = indexedDatabase()
    vi.stubGlobal('indexedDB', database.factory)
    const original = stateWithBiometrics()
    await savePeopleTimelineState(namespace, original)
    database.overwriteMetadata(namespace, { ...database.storedValue(namespace) as object,
      faceScanStorage: { version: 1, writeId: 'another-context-commit' },
    })
    database.overwriteScan(namespace, 'photo:portrait', { scannedAt: 'another-write', faces: [] })
    database.scanPut.mockClear()

    expect(await savePeopleTimelineState(namespace, original)).toBe(true)

    expect(database.scanPut).toHaveBeenCalledExactlyOnceWith(original.faceScans['photo:portrait'], [namespace, 'photo:portrait'])
    expect(await loadPeopleTimelineState(namespace)).toEqual(original)
  })

  it('removes a stale localStorage fallback after IndexedDB becomes authoritative', async () => {
    const namespace = 'family:stale-fallback'
    window.localStorage.setItem(fallbackKey(namespace), JSON.stringify({
      ...emptyPeopleTimelineState(),
      embeddings: { 'photo:old': [[1, 0]] },
    }))
    vi.stubGlobal('indexedDB', indexedDatabase().factory)

    await expect(
      savePeopleTimelineState(namespace, emptyPeopleTimelineState()),
    ).resolves.toBe(true)
    expect(window.localStorage.getItem(fallbackKey(namespace))).toBeNull()
  })

  it('reports when neither IndexedDB nor localStorage can persist a clear', async () => {
    vi.stubGlobal('indexedDB', undefined)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage denied')
    })

    await expect(
      savePeopleTimelineState('family:blocked', emptyPeopleTimelineState()),
    ).resolves.toBe(false)
  })

  it('reports a stale fallback that could not be removed', async () => {
    vi.stubGlobal('indexedDB', indexedDatabase().factory)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('Storage denied')
    })

    await expect(
      savePeopleTimelineState('family:blocked-cleanup', emptyPeopleTimelineState()),
    ).resolves.toBe(false)
  })
})
