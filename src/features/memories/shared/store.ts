import type {
  MomentStore,
  SavePanoramaMomentInput,
  StoredPanoramaAnnotation,
  StoredPanoramaMoment,
} from './types'

const DATABASE_PREFIX = 'kinsphere-family-moments'
const DATABASE_VERSION = 1
const STORE_NAME = 'panoramas'

/** Provides deterministic newest-first ordering for capture timestamps. */
function compareNewestFirst(
  first: StoredPanoramaMoment,
  second: StoredPanoramaMoment,
) {
  return second.createdAt.localeCompare(first.createdAt)
}

/** Clones mutable annotation metadata at the store boundary. */
function cloneAnnotation(
  annotation: StoredPanoramaAnnotation,
): StoredPanoramaAnnotation {
  return { ...annotation }
}

/** Returns an isolated moment record, including nested annotation copies. */
function cloneMoment(moment: StoredPanoramaMoment): StoredPanoramaMoment {
  return {
    ...moment,
    annotations: (moment.annotations ?? []).map(cloneAnnotation),
  }
}

/** Generates a collision-resistant identifier for locally captured panoramas. */
function createMomentId() {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID()
  }

  return `moment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Converts optional capture dates to valid ISO timestamps. */
function normalizeCreatedAt(value: string | Date | undefined) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())

  if (Number.isNaN(date.getTime())) {
    throw new TypeError('createdAt must be a valid date')
  }

  return date.toISOString()
}

/** Enforces non-empty text fields before a capture is persisted. */
function requiredText(value: string, field: string) {
  const normalized = value.trim()
  if (!normalized) {
    throw new TypeError(`${field} is required`)
  }
  return normalized
}

/** Rejects non-finite or non-positive panorama dimensions. */
function positiveDimension(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive number`)
  }
  return Math.round(value)
}

/** Validates and normalizes capture input before any store persists it. */
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
    ...(input.isDraft ? { isDraft: true } : {}),
    ownedByCurrentUser: input.ownedByCurrentUser ?? false,
    familySynced: input.familySynced ?? false,
    annotations: (input.annotations ?? []).map(cloneAnnotation),
  }
}

/** Creates an isolated in-memory store suitable for previews and fallbacks. */
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
    async remove(ids) {
      ids.forEach((id) => records.delete(id))
    },
  }
}

/** Names the IndexedDB database by account to prevent cross-account leakage. */
export function momentDatabaseNameForSubject(subject: string) {
  const namespace = subject.trim() || 'signed-out'
  return `${DATABASE_PREFIX}:${encodeURIComponent(namespace)}`
}

/** Opens and upgrades an account-scoped moment database. */
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

/** Creates an account-scoped IndexedDB implementation of the moment store. */
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

    async remove(ids) {
      if (ids.length === 0) return
      const database = await openDatabase(indexedDb, databaseName)

      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, 'readwrite')
          const objectStore = transaction.objectStore(STORE_NAME)
          ids.forEach((id) => objectStore.delete(id))
          transaction.oncomplete = () => resolve()
          transaction.onerror = () =>
            reject(transaction.error ?? new Error('Could not remove the moments'))
          transaction.onabort = () =>
            reject(
              transaction.error ?? new Error('Removing the moments was aborted'),
            )
        })
      } finally {
        database.close()
      }
    },
  }
}

/**
 * Uses the fallback only after the primary store fails. Mirroring into the
 * fallback is best effort: a cache failure must not invalidate a successful
 * durable operation or hide records returned by the primary store.
 */
export function createResilientMomentStore(
  primary: MomentStore,
  fallback: MomentStore = createMemoryMomentStore(),
): MomentStore {
  let fallbackOnly = false

  return {
    async list() {
      if (fallbackOnly) return fallback.list()

      let moments: StoredPanoramaMoment[]
      try {
        moments = await primary.list()
      } catch {
        fallbackOnly = true
        return fallback.list()
      }

      await Promise.allSettled(
        moments.map((moment) => fallback.save(moment)),
      )
      return moments
    },

    async save(moment) {
      if (fallbackOnly) return fallback.save(moment)

      try {
        await primary.save(moment)
      } catch {
        fallbackOnly = true
        return fallback.save(moment)
      }

      try {
        await fallback.save(moment)
      } catch {
        // The primary save is already durable; the fallback is only a cache.
      }
    },

    async remove(ids) {
      if (fallbackOnly) return fallback.remove(ids)

      try {
        await primary.remove(ids)
      } catch {
        fallbackOnly = true
        return fallback.remove(ids)
      }

      try {
        await fallback.remove(ids)
      } catch {
        // A cache cleanup failure cannot undo a successful durable deletion.
      }
    },
  }
}

/** Selects the durable browser store, or memory storage during SSR. */
export function createDefaultMomentStore(
  subject = 'local-preview',
): MomentStore {
  if (
    typeof window === 'undefined' ||
    typeof window.indexedDB === 'undefined'
  ) {
    return createMemoryMomentStore()
  }

  // A memory fallback can make a save appear successful and then disappear on
  // restart. Default app storage must surface IndexedDB failures so capture can
  // retain its native source frames and offer a retry instead.
  return createIndexedDbMomentStore(window.indexedDB, subject)
}
