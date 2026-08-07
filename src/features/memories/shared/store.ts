import type {
  MomentStore,
  SavePanoramaMomentInput,
  StoredPanoramaAnnotation,
  StoredPanoramaMoment,
} from './types'

const DATABASE_PREFIX = 'kinsphere-family-moments'
const DATABASE_VERSION = 1
const STORE_NAME = 'panoramas'

function compareNewestFirst(
  first: StoredPanoramaMoment,
  second: StoredPanoramaMoment,
) {
  return second.createdAt.localeCompare(first.createdAt)
}

function cloneAnnotation(
  annotation: StoredPanoramaAnnotation,
): StoredPanoramaAnnotation {
  return { ...annotation }
}

function cloneMoment(moment: StoredPanoramaMoment): StoredPanoramaMoment {
  return {
    ...moment,
    annotations: (moment.annotations ?? []).map(cloneAnnotation),
  }
}

function createMomentId() {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID()
  }

  return `moment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function normalizeCreatedAt(value: string | Date | undefined) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())

  if (Number.isNaN(date.getTime())) {
    throw new TypeError('createdAt must be a valid date')
  }

  return date.toISOString()
}

function requiredText(value: string, field: string) {
  const normalized = value.trim()
  if (!normalized) {
    throw new TypeError(`${field} is required`)
  }
  return normalized
}

function positiveDimension(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive number`)
  }
  return Math.round(value)
}

export function preparePanoramaMoment(
  input: SavePanoramaMomentInput,
): StoredPanoramaMoment {
  const label = input.label?.trim() || 'Family panorama'

  return {
    id: input.id?.trim() || createMomentId(),
    blob: input.blob,
    label,
    caption: input.caption?.trim() ?? '',
    createdAt: normalizeCreatedAt(input.createdAt),
    width: positiveDimension(input.width, 'width'),
    height: positiveDimension(input.height, 'height'),
    source: input.source,
    uploaderDisplayName: requiredText(
      input.uploaderDisplayName,
      'uploaderDisplayName',
    ),
    annotations: (input.annotations ?? []).map(cloneAnnotation),
  }
}

export function createMemoryMomentStore(
  seed: StoredPanoramaMoment[] = [],
): MomentStore {
  const records = new Map(
    seed.map((moment) => [moment.id, cloneMoment(moment)]),
  )

  return {
    async list() {
      return [...records.values()].map(cloneMoment).sort(compareNewestFirst)
    },
    async save(moment) {
      records.set(moment.id, cloneMoment(moment))
    },
  }
}

export function momentDatabaseNameForSubject(subject: string) {
  const namespace = subject.trim() || 'signed-out'
  return `${DATABASE_PREFIX}:${encodeURIComponent(namespace)}`
}

function openDatabase(
  indexedDb: IDBFactory,
  databaseName: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(databaseName, DATABASE_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('Could not open local moment storage'))
    request.onblocked = () =>
      reject(new Error('Local moment storage is blocked by another tab'))
  })
}

export function createIndexedDbMomentStore(
  indexedDb: IDBFactory,
  subject = 'local-preview',
): MomentStore {
  const databaseName = momentDatabaseNameForSubject(subject)
  return {
    async list() {
      const database = await openDatabase(indexedDb, databaseName)

      try {
        return await new Promise<StoredPanoramaMoment[]>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, 'readonly')
          const request = transaction.objectStore(STORE_NAME).getAll()

          request.onsuccess = () =>
            resolve(
              (request.result as StoredPanoramaMoment[])
                .map(cloneMoment)
                .sort(compareNewestFirst),
            )
          request.onerror = () =>
            reject(request.error ?? new Error('Could not read saved moments'))
          transaction.onabort = () =>
            reject(
              transaction.error ?? new Error('Reading saved moments was aborted'),
            )
        })
      } finally {
        database.close()
      }
    },

    async save(moment) {
      const database = await openDatabase(indexedDb, databaseName)

      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, 'readwrite')
          transaction.objectStore(STORE_NAME).put(cloneMoment(moment))
          transaction.oncomplete = () => resolve()
          transaction.onerror = () =>
            reject(transaction.error ?? new Error('Could not save the moment'))
          transaction.onabort = () =>
            reject(transaction.error ?? new Error('Saving the moment was aborted'))
        })
      } finally {
        database.close()
      }
    },
  }
}

export function createResilientMomentStore(
  primary: MomentStore,
  fallback: MomentStore = createMemoryMomentStore(),
): MomentStore {
  let fallbackOnly = false

  return {
    async list() {
      if (fallbackOnly) return fallback.list()

      try {
        const moments = await primary.list()
        await Promise.all(moments.map((moment) => fallback.save(moment)))
        return moments
      } catch {
        fallbackOnly = true
        return fallback.list()
      }
    },

    async save(moment) {
      if (!fallbackOnly) {
        try {
          await primary.save(moment)
          await fallback.save(moment)
          return
        } catch {
          fallbackOnly = true
        }
      }

      await fallback.save(moment)
    },
  }
}

export function createDefaultMomentStore(
  subject = 'local-preview',
): MomentStore {
  if (
    typeof window === 'undefined' ||
    typeof window.indexedDB === 'undefined'
  ) {
    return createMemoryMomentStore()
  }

  return createResilientMomentStore(
    createIndexedDbMomentStore(window.indexedDB, subject),
  )
}
