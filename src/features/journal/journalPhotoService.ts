import {
  getClerkSupabaseIdentity,
  getSupabaseClient,
} from '../../lib/supabase'
import { bootstrapCurrentClerkProfile } from '../../services/persistence'
import type { ProcessedCapsulePhoto } from '../capsules/types'
import type { JournalPhoto } from './journalPhotoTypes'

type JournalPhotoRow = {
  id?: unknown
  image_path?: unknown
  thumbnail_path?: unknown
  image_width?: unknown
  image_height?: unknown
  thumbnail_width?: unknown
  thumbnail_height?: unknown
  caption?: unknown
  captured_at?: unknown
  uploader_id?: unknown
  uploader?: unknown
}

/** Restricts client-selected IDs to canonical UUIDs accepted by persistence. */
function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** Produces a UUID v4 when the convenience browser API is unavailable. */
function createUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Normalizes Supabase's one-to-one relation shape into safe contributor copy. */
function displayNameFromRelation(value: unknown, fallback: string) {
  const relation = Array.isArray(value) ? value[0] : value
  if (!relation || typeof relation !== 'object') return fallback
  const displayName = (relation as { display_name?: unknown }).display_name
  return typeof displayName === 'string' && displayName.trim()
    ? displayName.trim()
    : fallback
}

/** Resolves the approved family and rejects stale callers from another namespace. */
async function currentFamilyContext(expectedCacheNamespace?: string) {
  const client = getSupabaseClient()
  const identity = getClerkSupabaseIdentity()
  if (!client || !identity) return null
  const profile = await bootstrapCurrentClerkProfile()
  const { data, error } = await client
    .from('circle_members')
    .select('circle_id')
    .eq('user_id', profile.userId)
    .eq('status', 'approved')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (typeof data?.circle_id !== 'string') return null
  if (
    expectedCacheNamespace &&
    `${identity.subject}:${data.circle_id}` !== expectedCacheNamespace
  ) return null
  return {
    client,
    circleId: data.circle_id,
    userId: profile.userId,
  }
}

/** Converts one untrusted row into UI data only when every media URL is usable. */
function normalizePhoto(
  row: JournalPhotoRow,
  signedUrls: Map<string, string>,
  currentUserId: string,
): JournalPhoto | null {
  if (
    typeof row.id !== 'string' || !isUuid(row.id) ||
    typeof row.image_path !== 'string' ||
    typeof row.thumbnail_path !== 'string' ||
    typeof row.image_width !== 'number' ||
    typeof row.image_height !== 'number' ||
    typeof row.captured_at !== 'string'
  ) return null

  const image = signedUrls.get(row.image_path)
  const thumbnail = signedUrls.get(row.thumbnail_path)
  const capturedAt = new Date(row.captured_at)
  if (!image || !thumbnail || !Number.isFinite(capturedAt.getTime())) return null

  return {
    id: row.id,
    image,
    thumbnail,
    width: row.image_width,
    height: row.image_height,
    thumbnailWidth: typeof row.thumbnail_width === 'number'
      ? row.thumbnail_width
      : undefined,
    thumbnailHeight: typeof row.thumbnail_height === 'number'
      ? row.thumbnail_height
      : undefined,
    caption: typeof row.caption === 'string' ? row.caption : '',
    capturedAt: capturedAt.toISOString(),
    contributorName: displayNameFromRelation(row.uploader, 'Family'),
    ownedByCurrentUser: row.uploader_id === currentUserId,
    syncStatus: 'synced',
  }
}

/** Fetches validated family-library metadata with fresh signed media URLs. */
export async function fetchFamilyJournalPhotos(
  expectedCacheNamespace?: string,
): Promise<JournalPhoto[] | null> {
  const context = await currentFamilyContext(expectedCacheNamespace)
  if (!context) return null

  // Read in bounded pages because a long-running family can exceed the server's
  // default result limit without any one response becoming excessively large.
  const rows: JournalPhotoRow[] = []
  const pageSize = 500
  for (let offset = 0; ; offset += pageSize) {
    const result = await context.client
      .from('family_journal_photos')
      .select('id,image_path,thumbnail_path,image_width,image_height,thumbnail_width,thumbnail_height,caption,captured_at,uploader_id,uploader:profiles!family_journal_photos_uploader_id_fkey(display_name)')
      .eq('circle_id', context.circleId)
      .order('captured_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + pageSize - 1)
    if (result.error) throw result.error
    const page = (result.data ?? []) as JournalPhotoRow[]
    rows.push(...page)
    if (page.length < pageSize) break
  }

  const uniqueRows = [...new Map(
    rows
      .filter(({ id }) => typeof id === 'string')
      .map((row) => [row.id as string, row]),
  ).values()]
  const paths = uniqueRows
    .flatMap((row) => [row.image_path, row.thumbnail_path])
    .filter((path): path is string => typeof path === 'string')
  const signedUrls = new Map<string, string>()
  // Storage signs at most a bounded batch at once; the map reconnects results
  // to their original database paths without depending on row order later.
  for (let offset = 0; offset < paths.length; offset += 100) {
    const pathBatch = paths.slice(offset, offset + 100)
    const { data, error } = await context.client.storage
      .from('family-media')
      .createSignedUrls(pathBatch, 60 * 60)
    if (error) throw error
    data.forEach((entry, index) => {
      const path = pathBatch[index]
      if (path && entry.signedUrl) signedUrls.set(path, entry.signedUrl)
    })
  }

  return uniqueRows
    .map((row) => normalizePhoto(row, signedUrls, context.userId))
    .filter((photo): photo is JournalPhoto => photo !== null)
}

/** Uploads processed photo variants and records one idempotent library row. */
export async function uploadFamilyJournalPhoto(input: {
  photoId?: string
  photo: ProcessedCapsulePhoto
  caption: string
  capturedAt: string
  expectedCacheNamespace?: string
}) {
  const context = await currentFamilyContext(input.expectedCacheNamespace)
  if (!context) return null
  const photoId = input.photoId && isUuid(input.photoId)
    ? input.photoId
    : createUuid()
  const imagePath = `${context.circleId}/journal-images/${context.userId}/${photoId}.jpg`
  const thumbnailPath = `${context.circleId}/journal-thumbnails/${context.userId}/${photoId}.jpg`
  const bucket = context.client.storage.from('family-media')

  // Retry-safe uploads return early when the same owner already finalized this
  // ID, avoiding a second pair of immutable storage objects.
  const existingResult = await context.client
    .from('family_journal_photos')
    .select('id')
    .eq('id', photoId)
    .eq('circle_id', context.circleId)
    .eq('uploader_id', context.userId)
    .maybeSingle()
  if (existingResult.error) throw existingResult.error
  if (existingResult.data?.id === photoId) return photoId

  await bucket.remove([imagePath, thumbnailPath]).catch(() => undefined)
  const [imageUpload, thumbnailUpload] = await Promise.all([
    bucket.upload(imagePath, input.photo.image, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: false,
    }),
    bucket.upload(thumbnailPath, input.photo.thumbnail, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: false,
    }),
  ])
  if (imageUpload.error || thumbnailUpload.error) {
    // Remove only the variant that succeeded so a partial upload cannot become
    // an unreferenced private-media object.
    const completedPaths = [
      imageUpload.error ? null : imagePath,
      thumbnailUpload.error ? null : thumbnailPath,
    ].filter((path): path is string => path !== null)
    if (completedPaths.length > 0) {
      await bucket.remove(completedPaths).catch(() => undefined)
    }
    throw imageUpload.error ?? thumbnailUpload.error
  }

  const { data, error } = await context.client.rpc('finalize_journal_photo', {
    p_circle_id: context.circleId,
    p_photo_id: photoId,
    p_image_path: imagePath,
    p_thumbnail_path: thumbnailPath,
    p_image_width: input.photo.width,
    p_image_height: input.photo.height,
    p_thumbnail_width: input.photo.thumbnailWidth,
    p_thumbnail_height: input.photo.thumbnailHeight,
    p_caption: input.caption || null,
    p_captured_at: input.capturedAt,
  })
  if (error || data !== photoId) {
    await bucket.remove([imagePath, thumbnailPath]).catch(() => undefined)
    throw error ?? new Error('The family photo could not be finalized securely.')
  }
  return photoId
}

/** Subscribes to family-library changes and returns a cleanup callback. */
export async function subscribeToFamilyJournalPhotos(
  onChange: () => void,
  expectedCacheNamespace?: string,
) {
  const context = await currentFamilyContext(expectedCacheNamespace)
  if (!context) return () => undefined
  const channel = context.client
    .channel(`family-journal-photos:${context.circleId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'family_journal_photos',
        filter: `circle_id=eq.${context.circleId}`,
      },
      onChange,
    )
    .subscribe()
  return () => {
    void context.client.removeChannel(channel)
  }
}
