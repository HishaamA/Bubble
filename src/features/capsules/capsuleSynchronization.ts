import { isCapsuleUnlocked } from './capsuleDates'
import {
  createCurrentWeeklyCapsule,
  mergeCapsules,
  orderCapsules,
} from './capsuleReconciliation'
import {
  createFamilySpecialCapsule,
  ensureFamilyWeeklyCapsule,
  fetchFamilyCapsules,
  uploadFamilyCapsulePhoto,
} from './capsuleService'
import type { CapsuleSyncResult } from './capsuleSessionCache'
import type { CapsuleStore, FamilyCapsule } from './types'
import { fetchFamilyCapsuleDeletions } from './capsuleDeletionService'
import { applyCapsuleRemovals, retainCapsuleRemovals } from './capsuleRemovalState'

export type CapsuleSynchronizationInput = {
  store: CapsuleStore
  displayName: string
  now: Date
  localWeekKey: string
  isCurrent?: () => boolean
  cacheNamespace?: string
}

type AssertCurrentSession = () => void

/** Makes the local store exactly match the newly reconciled Capsule snapshot. */
async function persistCapsuleSnapshot(
  store: CapsuleStore,
  previous: FamilyCapsule[],
  next: FamilyCapsule[],
): Promise<void> {
  const nextIds = new Set(next.map(({ id }) => id))
  await Promise.all([
    ...previous
      .filter(({ id }) => !nextIds.has(id))
      .map(({ id }) => store.remove(id)),
    ...next.map((capsule) => store.save(capsule)),
  ])
}

/** Updates the working snapshot's draft IDs before their queued photos upload. */
async function synchronizeSpecialDrafts(
  capsules: FamilyCapsule[],
  assertCurrent: AssertCurrentSession,
): Promise<boolean> {
  let remoteMutationSucceeded = false

  for (let index = 0; index < capsules.length; index += 1) {
    const capsule = capsules[index]
    if (capsule.kind !== 'special' || capsule.familySynced !== false) continue
    assertCurrent()
    try {
      const familyId = await createFamilySpecialCapsule(
        capsule.title,
        capsule.opensAt,
        capsule.id,
      )
      assertCurrent()
      if (familyId) {
        remoteMutationSucceeded = true
        capsules[index] = {
          ...capsule,
          id: familyId,
          familySynced: true,
          photos: capsule.photos.map((photo) => ({
            ...photo,
            capsuleId: familyId,
          })),
        }
      }
    } catch {
      // The durable local draft remains pending for the next refresh/resume.
    }
  }

  return remoteMutationSucceeded
}

/** Retries only durable pending media while its shared Capsule is still sealed. */
async function synchronizePendingPhotos(
  capsules: FamilyCapsule[],
  now: Date,
  assertCurrent: AssertCurrentSession,
): Promise<boolean> {
  let remoteMutationSucceeded = false

  for (let capsuleIndex = 0; capsuleIndex < capsules.length; capsuleIndex += 1) {
    const capsule = capsules[capsuleIndex]
    if (capsule.familySynced !== true || isCapsuleUnlocked(capsule.opensAt, now)) continue
    const photos = [...capsule.photos]
    for (let photoIndex = 0; photoIndex < photos.length; photoIndex += 1) {
      const photo = photos[photoIndex]
      if (
        photo.syncStatus !== 'pending' ||
        typeof photo.image === 'string' ||
        typeof photo.thumbnail === 'string' ||
        !photo.thumbnailWidth ||
        !photo.thumbnailHeight
      ) continue
      assertCurrent()
      try {
        const familyPhotoId = await uploadFamilyCapsulePhoto({
          capsuleId: capsule.id,
          itemId: photo.id,
          photo: {
            image: photo.image,
            thumbnail: photo.thumbnail,
            width: photo.width,
            height: photo.height,
            thumbnailWidth: photo.thumbnailWidth,
            thumbnailHeight: photo.thumbnailHeight,
          },
          caption: photo.caption,
          capturedAt: photo.capturedAt,
        })
        assertCurrent()
        if (familyPhotoId) {
          remoteMutationSucceeded = true
          photos[photoIndex] = {
            ...photo,
            id: familyPhotoId,
            capsuleId: capsule.id,
            syncStatus: 'synced',
          }
        }
      } catch {
        // Keep the re-encoded Blobs in IndexedDB and retry on refresh/resume.
      }
    }
    capsules[capsuleIndex] = { ...capsule, photos }
  }

  return remoteMutationSucceeded
}

/** Reconciles drafts, remote rows, and queued photos into one durable snapshot. */
export async function synchronizeCapsuleSnapshot(
  input: CapsuleSynchronizationInput,
): Promise<CapsuleSyncResult> {
  const assertCurrent = () => {
    if (input.isCurrent?.() === false) throw new Error('This family session has ended.')
  }
  const saved = await input.store.list()
  assertCurrent()
  let next = saved
  let authoritativeWeeklyId = ''

  try {
    if (input.cacheNamespace) {
      const markers = await fetchFamilyCapsuleDeletions(input.cacheNamespace)
      assertCurrent()
      if (markers) retainCapsuleRemovals(input.cacheNamespace, markers)
      next = applyCapsuleRemovals(next, input.cacheNamespace)
    }
    const authoritativeWeekly = await ensureFamilyWeeklyCapsule()
    assertCurrent()
    if (authoritativeWeekly) {
      authoritativeWeeklyId = authoritativeWeekly.id
      next = mergeCapsules(next, await fetchFamilyCapsules())
      if (input.cacheNamespace) next = applyCapsuleRemovals(next, input.cacheNamespace)
      assertCurrent()
      const createdAnyDrafts = await synchronizeSpecialDrafts(next, assertCurrent)
      const uploadedAnyPhotos = await synchronizePendingPhotos(next, input.now, assertCurrent)

      if (createdAnyDrafts || uploadedAnyPhotos) {
        assertCurrent()
        try {
          next = mergeCapsules(next, await fetchFamilyCapsules())
        } catch {
          // Successful writes remain local until signed URLs can refresh.
        }
      }
    }
  } catch {
    // No remote family context: keep the account-and-family-scoped local queue.
  }

  assertCurrent()
  if (!authoritativeWeeklyId) {
    const localWeekly = next.find(
      (capsule) => capsule.kind === 'weekly' && capsule.weekStart === input.localWeekKey,
    )
    if (localWeekly) {
      authoritativeWeeklyId = localWeekly.id
    } else {
      const weekly = createCurrentWeeklyCapsule(
        new Date(`${input.localWeekKey}T12:00:00`),
        input.displayName,
      )
      next = [weekly, ...next]
      authoritativeWeeklyId = weekly.id
    }
  }

  if (input.cacheNamespace) next = applyCapsuleRemovals(next, input.cacheNamespace)
  next = orderCapsules(next)
  await persistCapsuleSnapshot(input.store, saved, next)
  return { capsules: next, authoritativeWeeklyId }
}
