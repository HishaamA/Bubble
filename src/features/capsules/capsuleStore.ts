import type { CapsuleStore, FamilyCapsule } from './types'

const DATABASE_PREFIX = 'kinsphere-family-capsules'
const DATABASE_VERSION = 1
const STORE_NAME = 'capsules'

function cloneCapsule(capsule: FamilyCapsule): FamilyCapsule {
  return {
    ...capsule,
    photos: capsule.photos.map((photo) => ({ ...photo })),
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
      records.set(capsule.id, cloneCapsule(capsule))
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
          request.onsuccess = () => resolve(
            (request.result as FamilyCapsule[]).map(cloneCapsule).sort(newestFirst),
          )
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
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE_NAME, 'readwrite')
          transaction.objectStore(STORE_NAME).put(cloneCapsule(capsule))
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
  let fallbackOnly = false
  return {
    async list() {
      if (fallbackOnly) return fallback.list()
      try {
        const capsules = await primary.list()
        await Promise.all(capsules.map((capsule) => fallback.save(capsule)))
        return capsules
      } catch {
        fallbackOnly = true
        return fallback.list()
      }
    },
    async save(capsule) {
      if (!fallbackOnly) {
        try {
          await primary.save(capsule)
          await fallback.save(capsule)
          return
        } catch {
          fallbackOnly = true
        }
      }
      await fallback.save(capsule)
    },
    async remove(capsuleId) {
      if (!fallbackOnly) {
        try {
          await primary.remove(capsuleId)
          await fallback.remove(capsuleId)
          return
        } catch {
          fallbackOnly = true
        }
      }
      await fallback.remove(capsuleId)
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
