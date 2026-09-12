import { getCapsuleFamilyContext } from './capsuleService'

export type CapsuleDeletionMarker = {
  capsuleId: string
  creatorId: string
  ownedByCurrentUser: boolean
  /** Server-confirmed removal of a published row, not a private draft cancellation. */
  wasPublished?: boolean
  weekStart?: string
}

export type CapsulePhotoDeletionMarker = {
  capsuleId: string
  photoId: string
  uploaderId: string
  ownedByCurrentUser: boolean
  /** Enables pruning old family caches without granting private cancellations wider scope. */
  wasPublished?: boolean
}

export type CapsuleDeletionSnapshot = {
  capsules: CapsuleDeletionMarker[]
  photos: CapsulePhotoDeletionMarker[]
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value)

async function deletionContext(cacheNamespace: string) {
  const context = await getCapsuleFamilyContext(cacheNamespace)
  if (!context || !context.isCurrent()) throw new Error('Reconnect to your family before deleting this Capsule content.')
  return context
}

/** Removes only the caller's contribution; no signed URL is trusted as a path. */
export async function deleteFamilyCapsulePhoto(capsuleId: string, photoId: string, cacheNamespace: string): Promise<void> {
  if (!isUuid(capsuleId) || !isUuid(photoId)) throw new Error('Choose a valid Capsule photo.')
  if (cacheNamespace.endsWith(':no-family')) return
  const context = await deletionContext(cacheNamespace)
  const { data, error } = await context.client.rpc('delete_family_capsule_photo', {
    p_circle_id: context.circleId, p_capsule_id: capsuleId, p_photo_id: photoId,
  })
  if (error || data !== true) throw new Error('This Capsule photo could not be deleted. Check your connection and try again.')
  if (!context.isCurrent()) return
  await context.client.storage.from('family-media').remove([
    `${context.circleId}/capsule-images/${context.userId}/${photoId}.jpg`,
    `${context.circleId}/capsule-thumbnails/${context.userId}/${photoId}.jpg`,
  ]).catch(() => undefined)
}

/** Creator-only removal. Weekly server shells remain to prevent auto-recreation. */
export async function deleteFamilyCapsule(capsuleId: string, cacheNamespace: string): Promise<void> {
  if (!isUuid(capsuleId)) throw new Error('Choose a valid Capsule.')
  if (cacheNamespace.endsWith(':no-family')) return
  const context = await deletionContext(cacheNamespace)
  const { data, error } = await context.client.rpc('delete_family_capsule', {
    p_circle_id: context.circleId, p_capsule_id: capsuleId,
  })
  if (error || data !== true) throw new Error('This Capsule could not be deleted. Only its creator can remove it for the family.')
}

/** Explicit, identity-scoped removals; missing deployment/connectivity is not deletion. */
export async function fetchFamilyCapsuleDeletions(cacheNamespace: string): Promise<CapsuleDeletionSnapshot | null> {
  const context = await getCapsuleFamilyContext(cacheNamespace)
  if (!context || !context.isCurrent()) return null
  const capsules = new Map<string, CapsuleDeletionMarker>()
  const photos = new Map<string, CapsulePhotoDeletionMarker>()
  for (const table of ['deleted_family_capsules', 'deleted_family_capsule_photos'] as const) {
    for (let offset = 0; ; offset += 500) {
      const isCapsule = table === 'deleted_family_capsules'
      let query = context.client.from(table)
        .select(isCapsule ? 'capsule_id,creator_id,week_start,was_published' : 'capsule_id,photo_id,uploader_id,was_published')
        .eq('circle_id', context.circleId)
        .order('capsule_id').order(isCapsule ? 'creator_id' : 'photo_id')
      if (!isCapsule) query = query.order('uploader_id')
      const { data, error } = await query.range(offset, offset + 499)
      if (error) throw error
      if (!context.isCurrent()) return null
      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        if (!isUuid(row.capsule_id)) continue
        if (isCapsule && isUuid(row.creator_id)) {
          capsules.set(`${row.capsule_id}:${row.creator_id}`, {
            capsuleId: row.capsule_id, creatorId: row.creator_id,
            ownedByCurrentUser: row.creator_id === context.userId,
            wasPublished: row.was_published === true,
            ...(typeof row.week_start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.week_start)
              ? { weekStart: row.week_start } : {}),
          })
        } else if (!isCapsule && isUuid(row.photo_id) && isUuid(row.uploader_id)) {
          photos.set(`${row.capsule_id}:${row.photo_id}:${row.uploader_id}`, {
            capsuleId: row.capsule_id, photoId: row.photo_id, uploaderId: row.uploader_id,
            ownedByCurrentUser: row.uploader_id === context.userId,
            wasPublished: row.was_published === true,
          })
        }
      }
      if ((data?.length ?? 0) < 500) break
    }
  }
  return { capsules: [...capsules.values()], photos: [...photos.values()] }
}

export async function subscribeToFamilyCapsuleDeletions(onChange: () => void, cacheNamespace: string) {
  const context = await getCapsuleFamilyContext(cacheNamespace)
  if (!context || !context.isCurrent()) return () => undefined
  const changed = () => { if (context.isCurrent()) onChange() }
  const channel = context.client.channel(`capsule-deletions:${context.circleId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'deleted_family_capsules', filter: `circle_id=eq.${context.circleId}` }, changed)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'deleted_family_capsule_photos', filter: `circle_id=eq.${context.circleId}` }, changed)
    .subscribe()
  return () => { void context.client.removeChannel(channel) }
}
