import type {
  JournalPhoto,
  JournalPhotoStore,
} from './journalPhotoTypes'

const DATABASE_PREFIX = 'kinsphere-family-journal-photos'
const DATABASE_VERSION = 1
const STORE_NAME = 'photos'

/** Prevents callers from mutating records retained by the in-memory store. */
function clonePhoto(photo: JournalPhoto): JournalPhoto {
  return { ...photo }
}

/** Narrows IndexedDB values to plain records before field validation. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Accepts only media shapes supported by the journal renderer. */
function isImageSource(value: unknown): value is JournalPhoto['image'] {
  return value instanceof Blob || (typeof value === 'string' && value.length > 0)
}

/** Rejects non-integral or implausibly large stored image dimensions. */
function safeDimension(value: unknown, maximum: number) {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
}

/** Validates an untrusted IndexedDB photo before exposing it to the UI. */
export function parseStoredJournalPhoto(value: unknown): JournalPhoto | null {
  if (!isRecord(value)) return null
  const capturedAt = typeof value.capturedAt === 'string'
    ? new Date(value.capturedAt)
    : new Date(Number.NaN)
  if (
    typeof value.id !== 'string' || !value.id || value.id.length > 160 ||
    !isImageSource(value.image) || !isImageSource(value.thumbnail) ||
    !safeDimension(value.width, 4096) || !safeDimension(value.height, 4096) ||
    (value.thumbnailWidth !== undefined && !safeDimension(value.thumbnailWidth, 1024)) ||
    (value.thumbnailHeight !== undefined && !safeDimension(value.thumbnailHeight, 1024)) ||
    typeof value.caption !== 'string' || value.caption.length > 240 ||
    !Number.isFinite(capturedAt.getTime()) ||
    typeof value.contributorName !== 'string' || value.contributorName.length > 160 ||
    typeof value.ownedByCurrentUser !== 'boolean' ||
    (value.syncStatus !== 'pending' && value.syncStatus !== 'synced')
  ) return null

  return {
    id: value.id,
    image: value.image,
    thumbnail: value.thumbnail,
    width: Number(value.width),
    height: Number(value.height),
    thumbnailWidth: value.thumbnailWidth === undefined
      ? undefined
      : Number(value.thumbnailWidth),
    thumbnailHeight: value.thumbnailHeight === undefined
      ? undefined
      : Number(value.thumbnailHeight),
    caption: value.caption,
    capturedAt: capturedAt.toISOString(),
    contributorName: value.contributorName,
    ownedByCurrentUser: value.ownedByCurrentUser,
    syncStatus: value.syncStatus,
  }
}

/** Keeps storage output deterministic when two photos share a timestamp. */
function newestFirst(left: JournalPhoto, right: JournalPhoto) {
  return right.capturedAt.localeCompare(left.capturedAt) ||
    right.id.localeCompare(left.id)
}

/** Converts process-local blob URLs back into restart-safe Blob data when possible. */
async function durableImageSource(source: JournalPhoto['image']) {
  if (
    typeof source !== 'string' ||
    typeof fetch !== 'function' ||
    !source.startsWith('blob:')
  ) return source

  try {
    const response = await fetch(source)
    if (!response.ok) return source
    return await response.blob()
  } catch {
    return source
  }
}

/** Resolves both image variants before a record crosses the storage boundary. */
async function preparePhotoForPersistence(photo: JournalPhoto) {
  const [image, thumbnail] = await Promise.all([
    durableImageSource(photo.image),
    durableImageSource(photo.thumbnail),
  ])
  return { ...photo, image, thumbnail }
}

/** Opens and upgrades the account database, surfacing blocked upgrades as errors. */
function openDatabase(indexedDb: IDBFactory, name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open(name, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('capturedAt', 'capturedAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(
      request.error ?? new Error('Could not open family photo storage.'),
    )
    request.onblocked = () => reject(
      new Error('Family photo storage is open in another app window.'),
    )
  })
}

/** Names the photo database by account and family cache namespace. */
export function journalPhotoDatabaseNameForSubject(subject: string) {
  return `${DATABASE_PREFIX}:${encodeURIComponent(subject.trim() || 'signed-out')}`
}

/** Creates an isolated in-memory photo store with validation and cloning. */
export function createMemoryJournalPhotoStore(
  seed: JournalPhoto[] = [],
): JournalPhotoStore {
  const records = new Map(
    seed
      .map(parseStoredJournalPhoto)
      .filter((photo): photo is JournalPhoto => photo !== null)
      .map((photo) => [photo.id, clonePhoto(photo)]),
  )
  return {
    async list() {
      return [...records.values()].map(clonePhoto).sort(newestFirst)
    },
    async save(photo) {
      const durablePhoto = parseStoredJournalPhoto(
        await preparePhotoForPersistence(photo),
      )
      if (!durablePhoto) throw new Error('This family photo is invalid.')
      records.set(photo.id, clonePhoto(durablePhoto))
    },
    async remove(photoId) {
      records.delete(photoId)
    },
  }
}

/** Creates an account-scoped IndexedDB store for durable local photo copies. */
export function createIndexedDbJournalPhotoStore(
  indexedDb: IDBFactory,
  subject: string,
): JournalPhotoStore {
  const databaseName = journalPhotoDatabaseNameForSubject(subject)
  return {
    async list() {
      const database = await openDatabase(indexedDb, databaseName)
      try {
        return await new Promise<JournalPhoto[]>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, 'readonly')
          const request = transaction.objectStore(STORE_NAME).getAll()
          request.onsuccess = () => resolve(
            request.result
              .map(parseStoredJournalPhoto)
              .filter((photo): photo is JournalPhoto => photo !== null)
              .map(clonePhoto)
              .sort(newestFirst),
          )
          request.onerror = () => reject(
            request.error ?? new Error('Could not read family photos.'),
          )
          transaction.onabort = () => reject(
            transaction.error ?? new Error('Reading family photos was interrupted.'),
          )
        })
      } finally {
        database.close()
      }
    },
    async save(photo) {
      const database = await openDatabase(indexedDb, databaseName)
      try {
        const durablePhoto = parseStoredJournalPhoto(
          await preparePhotoForPersistence(photo),
        )
        if (!durablePhoto) throw new Error('This family photo is invalid.')
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, 'readwrite')
          transaction.objectStore(STORE_NAME).put(clonePhoto(durablePhoto))
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(
            transaction.error ?? new Error('Could not save this family photo.'),
          )
          transaction.onabort = () => reject(
            transaction.error ?? new Error('Saving this family photo was interrupted.'),
          )
        })
      } finally {
        database.close()
      }
    },
    async remove(photoId) {
      const database = await openDatabase(indexedDb, databaseName)
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, 'readwrite')
          transaction.objectStore(STORE_NAME).delete(photoId)
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(
            transaction.error ?? new Error('Could not remove this family photo.'),
          )
          transaction.onabort = () => reject(
            transaction.error ?? new Error('Removing this family photo was interrupted.'),
          )
        })
      } finally {
        database.close()
      }
    },
  }
}

/** Selects IndexedDB in browsers and memory storage during SSR. */
export function createDefaultJournalPhotoStore(subject: string) {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return createMemoryJournalPhotoStore()
  }
  return createIndexedDbJournalPhotoStore(window.indexedDB, subject)
}
