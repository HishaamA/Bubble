import { deleteFamilyCapsule, deleteFamilyCapsulePhoto } from './capsuleDeletionService'
import { applyCapsuleRemovals, retainCapsuleRemovals } from './capsuleRemovalState'
import { getCapsuleSession, retainCapsuleSessionDraft } from './capsuleSessionCache'
import { notifyLocalCapsulesChanged } from './capsuleChanges'
import type { CapsuleStore, FamilyCapsule } from './types'

function ownCapsule(capsule: FamilyCapsule) {
  return capsule.ownedByCurrentUser === true || capsule.familySynced === false
}
export { ownCapsule as canDeleteCapsule }

/** Commits only after ownership-checked remote removal, then prunes every local consumer. */
export async function removeCapsuleContent({ scope, capsule, photoId, store: suppliedStore }: {
  scope: string
  capsule: FamilyCapsule
  photoId?: string
  store?: CapsuleStore
}) {
  const session = getCapsuleSession(scope, suppliedStore)
  if (session.inFlight) await session.inFlight.catch(() => undefined)
  if (session.disposed) throw new Error('This family session has ended.')
  // A queued weekly draft can acquire the server's canonical UUID while we
  // wait for its upload. Resolve that identity before deciding local vs shared.
  const refreshed = session.result?.capsules ?? await session.store.list()
  capsule = refreshed.find((candidate) => candidate.id === capsule.id || (
    candidate.kind === 'weekly' && capsule.kind === 'weekly' && capsule.weekStart
    && candidate.weekStart === capsule.weekStart
  )) ?? capsule
  const photo = photoId ? capsule.photos.find(({ id }) => id === photoId) : undefined
  if (photoId ? !photo?.ownedByCurrentUser : !ownCapsule(capsule)) {
    throw new Error('Only the original uploader or Capsule creator can delete this for everyone.')
  }
  // Offline-only weekly drafts have deterministic non-UUID IDs. Other drafts
  // receive a server cancellation receipt too, blocking a late queued upload.
  const localOnly = scope.endsWith(':no-family') || scope === 'signed-out'
    || (capsule.familySynced === false && capsule.id.startsWith('weekly-'))
  if (!localOnly) {
    if (photoId) await deleteFamilyCapsulePhoto(capsule.id, photoId, scope)
    else await deleteFamilyCapsule(capsule.id, scope)
  }
  if (session.disposed) throw new Error('This family session has ended.')
  retainCapsuleRemovals(scope, photo ? {
    capsules: [], photos: [{ capsuleId: capsule.id, photoId: photo.id, uploaderId: photo.uploaderId, ownedByCurrentUser: true, wasPublished: photo.syncStatus === 'synced' }],
  } : {
    photos: [], capsules: [{ capsuleId: capsule.id, creatorId: capsule.createdById, ownedByCurrentUser: true, wasPublished: capsule.familySynced === true, weekStart: capsule.weekStart }],
  })
  const latest = await session.store.list()
  const next = applyCapsuleRemovals(latest, scope)
  const updated = next.find(({ id }) => id === capsule.id)
  if (updated) await session.store.save(updated)
  else await session.store.remove(capsule.id)
  retainCapsuleSessionDraft(session, {
    capsules: applyCapsuleRemovals(session.result?.capsules ?? next, scope),
    authoritativeWeeklyId: session.result?.authoritativeWeeklyId ?? '',
  })
  notifyLocalCapsulesChanged(scope)
  window.dispatchEvent(new Event('bubble:widget-data-changed'))
}
