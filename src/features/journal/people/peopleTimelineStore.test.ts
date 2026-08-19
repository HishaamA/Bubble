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
  let storedValue = initialValue
  const put = vi.fn((value: unknown, _key?: IDBValidKey) => {
    storedValue = value
  })
  const factory = {
    open: vi.fn(() => {
      const request: Record<string, unknown> = {}
      queueMicrotask(() => {
        const database = {
          objectStoreNames: { contains: () => true },
          transaction: (_storeName: string, mode: IDBTransactionMode) => {
            const transaction: Record<string, unknown> = {}
            transaction.objectStore = () => ({
              get: () => {
                const getRequest: Record<string, unknown> = {}
                queueMicrotask(() => {
                  getRequest.result = storedValue
                  const onsuccess = getRequest.onsuccess
                  if (typeof onsuccess === 'function') onsuccess()
                })
                return getRequest
              },
              put,
            })
            if (mode === 'readwrite') {
              queueMicrotask(() => {
                const oncomplete = transaction.oncomplete
                if (typeof oncomplete === 'function') oncomplete()
              })
            }
            return transaction
          },
          close: () => undefined,
        }
        request.result = database
        const onsuccess = request.onsuccess
        if (typeof onsuccess === 'function') onsuccess()
      })
      return request
    }),
  }

  return {
    factory,
    put,
    storedValue: () => storedValue,
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
    expect(database.put).toHaveBeenCalledWith(state, namespace)
    expect(database.storedValue()).toEqual(state)
    await expect(loadPeopleTimelineState(namespace)).resolves.toEqual(state)
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
