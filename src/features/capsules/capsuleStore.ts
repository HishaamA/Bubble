import type {
  CapsuleImageSource,
  CapsulePhoto,
  CapsuleStore,
  FamilyCapsule,
} from './types'

const DATABASE_PREFIX = 'kinsphere-family-capsules'
const DATABASE_VERSION = 2
const STORE_NAME = 'capsules'
const IMAGE_BYTES_FORMAT = 'kinsphere-capsule-image-bytes-v1'

type PersistedImageBytes = {
  format: typeof IMAGE_BYTES_FORMAT
  mimeType: string
  bytes: ArrayBuffer
}

type PersistedCapsulePhoto = Omit<CapsulePhoto, 'image' | 'thumbnail'> & {
  image: CapsuleImageSource | PersistedImageBytes
  thumbnail: CapsuleImageSource | PersistedImageBytes
}

type PersistedFamilyCapsule = Omit<FamilyCapsule, 'photos'> & {
  photos: PersistedCapsulePhoto[]
}

function cloneCapsule(capsule: FamilyCapsule): FamilyCapsule {
  return {
    ...capsule,
    photos: capsule.photos.map((photo) => ({ ...photo })),
  }
}

function isEphemeralObjectUrl(source: CapsuleImageSource): source is string {
  return typeof source === 'string' && source.startsWith('blob:')
}

async function durableImageSource(
  source: CapsuleImageSource,
): Promise<CapsuleImageSource> {
  if (!isEphemeralObjectUrl(source) || typeof fetch !== 'function') return source
  try {
    const response = await fetch(source)
    if (!response.ok) return source
    return await response.blob()
  } catch {
    // A legacy object URL cannot be recovered after its document closes. Keep
    // its metadata so the family-server refresh can replace it; the UI renders
    // an intentional placeholder instead of a browser broken-image icon.
    return source
  }
}

async function prepareCapsuleForPersistence(
  capsule: FamilyCapsule,
): Promise<FamilyCapsule> {
  return {
    ...capsule,
    photos: await Promise.all(capsule.photos.map(async (photo) => {
      const [image, thumbnail] = await Promise.all([
        durableImageSource(photo.image),
        durableImageSource(photo.thumbnail),
      ])
      return { ...photo, image, thumbnail }
    })),
  }
}

function isPersistedImageBytes(value: unknown): value is PersistedImageBytes {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PersistedImageBytes>
  return candidate.format === IMAGE_BYTES_FORMAT &&
    typeof candidate.mimeType === 'string' &&
    Object.prototype.toString.call(candidate.bytes) === '[object ArrayBuffer]'
}

async function serializeImageSource(
  source: CapsuleImageSource,
): Promise<CapsuleImageSource | PersistedImageBytes> {
  const durableSource = await durableImageSource(source)
  if (typeof durableSource === 'string') return durableSource
  try {
    return {
      format: IMAGE_BYTES_FORMAT,
      mimeType: durableSource.type,
      // Persist bytes rather than a file-backed Blob. WebKit can otherwise lose
      // access to an IndexedDB Blob's backing file after an iOS app restart.
      bytes: await durableSource.arrayBuffer(),
    }
  } catch {
    // Do not make an otherwise readable Capsule disappear if an older WebKit
    // Blob has already lost access to its backing file.
    return durableSource
  }
}

async function hydrateImageSource(
  source: CapsuleImageSource | PersistedImageBytes,
): Promise<CapsuleImageSource> {
  if (isPersistedImageBytes(source)) {
    return new Blob([source.bytes], { type: source.mimeType })
  }
  if (typeof source === 'string') return source
  // Materialize version-1 records into a fresh in-memory Blob. The next save
  // transparently migrates them to the byte-backed format above.
  try {
    return new Blob([await source.arrayBuffer()], { type: source.type })
  } catch {
    return source
  }
}

export async function serializeCapsuleForIndexedDb(
  capsule: FamilyCapsule,
): Promise<PersistedFamilyCapsule> {
  return {
    ...capsule,
    photos: await Promise.all(capsule.photos.map(async (photo) => {
      const [image, thumbnail] = await Promise.all([
        serializeImageSource(photo.image),
        serializeImageSource(photo.thumbnail),
      ])
      return { ...photo, image, thumbnail }
    })),
  }
}

export async function hydrateCapsuleFromIndexedDb(
  capsule: PersistedFamilyCapsule,
): Promise<FamilyCapsule> {
  return {
    ...capsule,
    photos: await Promise.all(capsule.photos.map(async (photo) => {
      const [image, thumbnail] = await Promise.all([
        hydrateImageSource(photo.image),
        hydrateImageSource(photo.thumbnail),
      ])
      return { ...photo, image, thumbnail }
    })),
  }
}

function newestFirst(left: FamilyCapsule, right: FamilyCapsule) {
  return right.createdAt.localeCompare(left.createdAt)
}

function openDatabase(indexedDb: IDBFactory, name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open(name, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open Capsule storage.'))
    request.onblocked = () => reject(new Error('Capsule storage is open in another tab.'))
  })
}

export function capsuleDatabaseNameForSubject(subject: string) {
  return `${DATABASE_PREFIX}:${encodeURIComponent(subject.trim() || 'signed-out')}`
}

export function createMemoryCapsuleStore(seed: FamilyCapsule[] = []): CapsuleStore {
  const records = new Map(seed.map((capsule) => [capsule.id, cloneCapsule(capsule)]))
  return {
    async list() {
      return [...records.values()].map(cloneCapsule).sort(newestFirst)
    },
    async save(capsule) {
      const durableCapsule = await prepareCapsuleForPersistence(capsule)
      records.set(capsule.id, cloneCapsule(durableCapsule))
    },
    async remove(capsuleId) {
      records.delete(capsuleId)
    },
  }
}

export function createIndexedDbCapsuleStore(
  indexedDb: IDBFactory,
  subject: string,
): CapsuleStore {
  const databaseName = capsuleDatabaseNameForSubject(subject)
  return {
    async list() {
      const database = await openDatabase(indexedDb, databaseName)
      try {
        return await new Promise<FamilyCapsule[]>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, 'readonly')
          const request = transaction.objectStore(STORE_NAME).getAll()
          request.onsuccess = () => {
            void Promise.all(
              (request.result as PersistedFamilyCapsule[])
                .map(hydrateCapsuleFromIndexedDb),
            ).then(
              (capsules) => resolve(capsules.map(cloneCapsule).sort(newestFirst)),
              reject,
            )
          }
          request.onerror = () => reject(request.error ?? new Error('Could not read Capsules.'))
          transaction.onabort = () => reject(transaction.error ?? new Error('Reading Capsules was interrupted.'))
        })
      } finally {
        database.close()
      }
    },
    async save(capsule) {
      const database = await openDatabase(indexedDb, databaseName)
      try {
        const durableCapsule = await serializeCapsuleForIndexedDb(capsule)
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, 'readwrite')
          transaction.objectStore(STORE_NAME).put(durableCapsule)
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error ?? new Error('Could not save the Capsule.'))
          transaction.onabort = () => reject(transaction.error ?? new Error('Saving the Capsule was interrupted.'))
        })
      } finally {
        database.close()
      }
    },
    async remove(capsuleId) {
      const database = await openDatabase(indexedDb, databaseName)
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, 'readwrite')
          transaction.objectStore(STORE_NAME).delete(capsuleId)
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error ?? new Error('Could not remove the Capsule.'))
          transaction.onabort = () => reject(transaction.error ?? new Error('Removing the Capsule was interrupted.'))
        })
      } finally {
        database.close()
      }
    },
  }
}

export function createResilientCapsuleStore(
  primary: CapsuleStore,
  fallback: CapsuleStore = createMemoryCapsuleStore(),
): CapsuleStore {
  type DirtyOperation =
    | { kind: 'save'; capsule: FamilyCapsule }
    | { kind: 'remove' }

  const dirtyOperations = new Map<string, DirtyOperation>()

  async function retryPrimary<T>(operation: () => Promise<T>) {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Capsule storage is temporarily unavailable.')
  }

  async function flushDirtyOperations() {
    for (const [capsuleId, operation] of [...dirtyOperations]) {
      if (operation.kind === 'save') {
        await retryPrimary(() => primary.save(operation.capsule))
      } else {
        await retryPrimary(() => primary.remove(capsuleId))
      }
      if (dirtyOperations.get(capsuleId) === operation) {
        dirtyOperations.delete(capsuleId)
      }
    }
  }

  return {
    async list() {
      try {
        await flushDirtyOperations()
        const capsules = await retryPrimary(() => primary.list())
        const capsuleIds = new Set(capsules.map(({ id }) => id))
        const fallbackCapsules = await fallback.list()
        await Promise.all([
          ...fallbackCapsules
            .filter(({ id }) => !capsuleIds.has(id))
            .map(({ id }) => fallback.remove(id)),
          ...capsules.map((capsule) => fallback.save(capsule)),
        ])
        return capsules
      } catch {
        return fallback.list()
      }
    },
    async save(capsule) {
      const durableCapsule = await prepareCapsuleForPersistence(capsule)
      const operation = {
        kind: 'save' as const,
        capsule: cloneCapsule(durableCapsule),
      }
      await fallback.save(durableCapsule)
      dirtyOperations.set(capsule.id, operation)
      await retryPrimary(() => primary.save(durableCapsule))
      if (dirtyOperations.get(capsule.id) === operation) {
        dirtyOperations.delete(capsule.id)
      }
    },
    async remove(capsuleId) {
      const operation = { kind: 'remove' as const }
      await fallback.remove(capsuleId)
      dirtyOperations.set(capsuleId, operation)
      await retryPrimary(() => primary.remove(capsuleId))
      if (dirtyOperations.get(capsuleId) === operation) {
        dirtyOperations.delete(capsuleId)
      }
    },
  }
}

export function createDefaultCapsuleStore(subject: string): CapsuleStore {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return createMemoryCapsuleStore()
  }
  return createResilientCapsuleStore(
    createIndexedDbCapsuleStore(window.indexedDB, subject),
  )
}
