import {
  getClerkSupabaseIdentity,
  getSupabaseClient,
} from '../../lib/supabase'
import { bootstrapCurrentClerkProfile } from '../../services/persistence'
import type {
  CapsulePhoto,
  FamilyCapsule,
  ProcessedCapsulePhoto,
} from './types'

type CapsuleRow = {
  id?: unknown
  kind?: unknown
  title?: unknown
  week_start?: unknown
  opens_at?: unknown
  closes_at?: unknown
  item_count?: unknown
  created_at?: unknown
  creator?: unknown
}

type CapsuleItemRow = {
  id?: unknown
  capsule_id?: unknown
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

export type FamilyWeeklyCapsulePointer = {
  id: string
  weekStart: string
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function createUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function displayNameFromRelation(value: unknown, fallback: string) {
  const relation = Array.isArray(value) ? value[0] : value
  if (!relation || typeof relation !== 'object') return fallback
  const displayName = (relation as { display_name?: unknown }).display_name
  return typeof displayName === 'string' && displayName.trim()
    ? displayName.trim()
    : fallback
}

async function currentFamilyContext() {
  const client = getSupabaseClient()
  if (!client || !getClerkSupabaseIdentity()) return null
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
  return {
    client,
    circleId: data.circle_id,
    userId: profile.userId,
  }
}

function normalizeCapsule(
  row: CapsuleRow,
  photos: CapsulePhoto[],
): FamilyCapsule | null {
  if (
    typeof row.id !== 'string' || !isUuid(row.id) ||
    (row.kind !== 'weekly' && row.kind !== 'special') ||
    typeof row.title !== 'string' ||
    typeof row.opens_at !== 'string' ||
    typeof row.closes_at !== 'string' ||
    typeof row.created_at !== 'string'
  ) return null

  const opensAt = new Date(row.opens_at)
  const closesAt = new Date(row.closes_at)
  const createdAt = new Date(row.created_at)
  if ([opensAt, closesAt, createdAt].some((date) => Number.isNaN(date.getTime()))) return null

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    weekStart: typeof row.week_start === 'string' ? row.week_start : undefined,
    opensAt: opensAt.toISOString(),
    closesAt: closesAt.toISOString(),
    createdAt: createdAt.toISOString(),
    createdByName: displayNameFromRelation(row.creator, 'Family'),
    photos,
    totalPhotoCount: typeof row.item_count === 'number' ? row.item_count : photos.length,
    familySynced: true,
  }
}

function normalizeItem(
  row: CapsuleItemRow,
  signedUrls: Map<string, string>,
  currentUserId: string,
): CapsulePhoto | null {
  if (
    typeof row.id !== 'string' || !isUuid(row.id) ||
    typeof row.capsule_id !== 'string' || !isUuid(row.capsule_id) ||
    typeof row.image_path !== 'string' ||
    typeof row.thumbnail_path !== 'string' ||
    typeof row.image_width !== 'number' ||
    typeof row.image_height !== 'number' ||
    typeof row.captured_at !== 'string'
  ) return null

  const image = signedUrls.get(row.image_path)
  const thumbnail = signedUrls.get(row.thumbnail_path)
  if (!image || !thumbnail) return null

  return {
    id: row.id,
    capsuleId: row.capsule_id,
    image,
    thumbnail,
    width: row.image_width,
    height: row.image_height,
    thumbnailWidth: typeof row.thumbnail_width === 'number' ? row.thumbnail_width : undefined,
    thumbnailHeight: typeof row.thumbnail_height === 'number' ? row.thumbnail_height : undefined,
    caption: typeof row.caption === 'string' ? row.caption : '',
    capturedAt: row.captured_at,
    contributorName: displayNameFromRelation(row.uploader, 'Family'),
    ownedByCurrentUser: row.uploader_id === currentUserId,
    syncStatus: 'synced',
  }
}

export async function ensureFamilyWeeklyCapsule() {
  const context = await currentFamilyContext()
  if (!context) return null
  const { data, error } = await context.client.rpc('get_or_create_weekly_capsule', {
    p_circle_id: context.circleId,
  })
  if (error) throw error
  const row = (Array.isArray(data) ? data[0] : data) as CapsuleRow | null
  if (
    !row || typeof row.id !== 'string' || !isUuid(row.id) ||
    typeof row.week_start !== 'string'
  ) {
    throw new Error('The family weekly Capsule could not be resolved securely.')
  }
  return { id: row.id, weekStart: row.week_start } satisfies FamilyWeeklyCapsulePointer
}

export async function fetchFamilyCapsules(): Promise<FamilyCapsule[]> {
  const context = await currentFamilyContext()
  if (!context) return []
  const capsuleResult = await context.client
    .from('family_capsules')
    .select('id,kind,title,week_start,opens_at,closes_at,item_count,created_at,creator:profiles!family_capsules_created_by_fkey(display_name)')
    .eq('circle_id', context.circleId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (capsuleResult.error) throw capsuleResult.error

  const capsuleRows = (capsuleResult.data ?? []) as CapsuleRow[]
  const capsuleIds = capsuleRows
    .map(({ id }) => id)
    .filter((id): id is string => typeof id === 'string' && isUuid(id))
  const itemRows: CapsuleItemRow[] = []
  const pageSize = 500
  if (capsuleIds.length > 0) {
    for (let offset = 0; ; offset += pageSize) {
      const itemResult = await context.client
        .from('family_capsule_items')
        .select('id,capsule_id,image_path,thumbnail_path,image_width,image_height,thumbnail_width,thumbnail_height,caption,captured_at,uploader_id,uploader:profiles!family_capsule_items_uploader_id_fkey(display_name)')
        .eq('circle_id', context.circleId)
        .in('capsule_id', capsuleIds)
        .order('captured_at', { ascending: true })
        .range(offset, offset + pageSize - 1)
      if (itemResult.error) throw itemResult.error
      const page = (itemResult.data ?? []) as CapsuleItemRow[]
      itemRows.push(...page)
      if (page.length < pageSize) break
    }
  }
  const paths = itemRows.flatMap((row) => [row.image_path, row.thumbnail_path])
    .filter((path): path is string => typeof path === 'string')
  const signedUrls = new Map<string, string>()
  for (let offset = 0; offset < paths.length; offset += 100) {
    const pathBatch = paths.slice(offset, offset + 100)
    const { data, error } = await context.client.storage
      .from('family-media')
      .createSignedUrls(pathBatch, 60 * 60)
    if (error) throw error
    data.forEach((entry, index) => {
      if (entry.signedUrl) signedUrls.set(pathBatch[index], entry.signedUrl)
    })
  }

  const photos = itemRows
    .map((row) => normalizeItem(row, signedUrls, context.userId))
    .filter((photo): photo is CapsulePhoto => photo !== null)
  const photosByCapsule = new Map<string, CapsulePhoto[]>()
  photos.forEach((photo) => {
    const current = photosByCapsule.get(photo.capsuleId) ?? []
    current.push(photo)
    photosByCapsule.set(photo.capsuleId, current)
  })

  return capsuleRows
    .map((row) => normalizeCapsule(
      row,
      typeof row.id === 'string' ? photosByCapsule.get(row.id) ?? [] : [],
    ))
    .filter((capsule): capsule is FamilyCapsule => capsule !== null)
}

export async function createFamilySpecialCapsule(
  title: string,
  opensAt: string,
  capsuleId = createUuid(),
) {
  const context = await currentFamilyContext()
  if (!context) return null
  const { data, error } = await context.client.rpc('create_special_capsule', {
    p_circle_id: context.circleId,
    p_title: title,
    p_opens_at: opensAt,
    p_capsule_id: capsuleId,
  })
  if (error) throw error
  return typeof data === 'string' && isUuid(data) ? data : null
}

export async function uploadFamilyCapsulePhoto(input: {
  capsuleId: string
  itemId?: string
  photo: ProcessedCapsulePhoto
  caption: string
  capturedAt: string
}) {
  if (!isUuid(input.capsuleId)) return null
  const context = await currentFamilyContext()
  if (!context) return null
  const itemId = input.itemId && isUuid(input.itemId) ? input.itemId : createUuid()
  const imagePath = `${context.circleId}/capsule-images/${context.userId}/${itemId}.jpg`
  const thumbnailPath = `${context.circleId}/capsule-thumbnails/${context.userId}/${itemId}.jpg`
  const bucket = context.client.storage.from('family-media')
  const existingResult = await context.client
    .from('family_capsule_items')
    .select('id')
    .eq('id', itemId)
    .eq('capsule_id', input.capsuleId)
    .eq('uploader_id', context.userId)
    .maybeSingle()
  if (existingResult.error) throw existingResult.error
  if (existingResult.data?.id === itemId) return itemId

  // A previous interrupted attempt may have left one or both unfinalized
  // immutable objects. The Storage policy permits the uploader to remove only
  // paths that are not referenced by a finalized item.
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
    const completedPaths = [
      imageUpload.error ? null : imagePath,
      thumbnailUpload.error ? null : thumbnailPath,
    ].filter((path): path is string => path !== null)
    if (completedPaths.length > 0) {
      await bucket.remove(completedPaths).catch(() => undefined)
    }
    throw imageUpload.error ?? thumbnailUpload.error
  }

  const { data, error } = await context.client.rpc('finalize_capsule_photo', {
    p_circle_id: context.circleId,
    p_capsule_id: input.capsuleId,
    p_item_id: itemId,
    p_image_path: imagePath,
    p_thumbnail_path: thumbnailPath,
    p_image_width: input.photo.width,
    p_image_height: input.photo.height,
    p_thumbnail_width: input.photo.thumbnailWidth,
    p_thumbnail_height: input.photo.thumbnailHeight,
    p_caption: input.caption || null,
    p_captured_at: input.capturedAt,
  })
  if (error || typeof data !== 'string' || !isUuid(data)) {
    await bucket.remove([imagePath, thumbnailPath]).catch(() => undefined)
    throw error ?? new Error('The family Capsule photo could not be finalized securely.')
  }
  return data
}

export async function subscribeToFamilyCapsules(onChange: () => void) {
  const context = await currentFamilyContext()
  if (!context) return () => undefined
  const channel = context.client
    .channel(`family-capsules:${context.circleId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'family_capsules',
        filter: `circle_id=eq.${context.circleId}`,
      },
      onChange,
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'family_capsule_items',
        filter: `circle_id=eq.${context.circleId}`,
      },
      onChange,
    )
    .subscribe()
  return () => {
    void context.client.removeChannel(channel)
  }
}
