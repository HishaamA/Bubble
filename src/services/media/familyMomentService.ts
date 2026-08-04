import type { Capture360Submission } from '../../features/capture'
import type { SavePanoramaMomentInput } from '../../features/memories/shared'
import {
  getClerkSupabaseIdentity,
  getSupabaseClient,
} from '../../lib/supabase'
import { bootstrapCurrentClerkProfile } from '../persistence'
import { processPanoramaForSharing } from './processPanorama'

const FAMILY_MEDIA_BUCKET = 'family-media'

export type FamilyMomentConnection = {
  userId: string
  circleId: string
}

export type FamilyDailyCaptureWindow = {
  startsAt: Date
  endsAt: Date
}

type FamilyMomentRow = {
  id: string
  uploader_id: string
  capture_kind: 'scheduled' | 'manual'
  panorama_path: string
  caption: string | null
  panorama_width: number
  panorama_height: number
  ready_at: string
}

export async function getFamilyMomentConnection(): Promise<
  FamilyMomentConnection | null
> {
  const client = getSupabaseClient()
  if (!client || !getClerkSupabaseIdentity()) return null
  const { userId } = await bootstrapCurrentClerkProfile()

  const { data, error } = await client
    .from('circle_members')
    .select('circle_id')
    .eq('user_id', userId)
    .eq('status', 'approved')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  if (!data?.circle_id) return null
  return { userId, circleId: String(data.circle_id) }
}

export async function publishFamilyMoment(
  connection: FamilyMomentConnection,
  submission: Capture360Submission,
) {
  const client = getSupabaseClient()
  if (!client) throw new Error('Family sync is not configured.')

  const processed = await processPanoramaForSharing(submission.file)
  const panoramaPath = `${connection.circleId}/panoramas/${connection.userId}/${submission.id}.jpg`
  const thumbnailPath = `${connection.circleId}/thumbnails/${connection.userId}/${submission.id}.jpg`

  const [panoramaUpload, thumbnailUpload] = await Promise.all([
    client.storage
      .from(FAMILY_MEDIA_BUCKET)
      .upload(panoramaPath, processed.viewer, {
        cacheControl: '31536000',
        contentType: 'image/jpeg',
        upsert: false,
      }),
    client.storage
      .from(FAMILY_MEDIA_BUCKET)
      .upload(thumbnailPath, processed.thumbnail, {
        cacheControl: '31536000',
        contentType: 'image/jpeg',
        upsert: false,
      }),
  ])

  if (panoramaUpload.error) throw panoramaUpload.error
  if (thumbnailUpload.error) throw thumbnailUpload.error

  const { error } = await client.rpc('finalize_360_moment', {
    p_circle_id: connection.circleId,
    p_moment_id: submission.id,
    p_capture_kind: submission.source === 'daily' ? 'scheduled' : 'manual',
    p_panorama_path: panoramaPath,
    p_thumbnail_path: thumbnailPath,
    p_panorama_width: processed.viewerWidth,
    p_panorama_height: processed.viewerHeight,
    p_thumbnail_width: processed.thumbnailWidth,
    p_thumbnail_height: processed.thumbnailHeight,
    p_caption: submission.caption || null,
  })
  if (error) throw error

  return processed
}

export async function getFamilyDailyCaptureWindow(
  connection: FamilyMomentConnection,
): Promise<FamilyDailyCaptureWindow | null> {
  const client = getSupabaseClient()
  if (!client) return null

  const { data, error } = await client.rpc(
    'get_or_create_daily_capture_window',
    { p_circle_id: connection.circleId },
  )
  if (error) throw error

  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') return null
  const record = row as { opens_at?: unknown; closes_at?: unknown }
  if (
    typeof record.opens_at !== 'string' ||
    typeof record.closes_at !== 'string'
  ) {
    return null
  }

  const startsAt = new Date(record.opens_at)
  const endsAt = new Date(record.closes_at)
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    return null
  }
  return { startsAt, endsAt }
}

export async function fetchFamilyMoments(
  connection: FamilyMomentConnection,
): Promise<SavePanoramaMomentInput[]> {
  const client = getSupabaseClient()
  if (!client) return []

  const { data, error } = await client
    .from('family_moments')
    .select(
      'id,uploader_id,capture_kind,panorama_path,caption,panorama_width,panorama_height,ready_at',
    )
    .eq('circle_id', connection.circleId)
    .eq('status', 'ready')
    .order('ready_at', { ascending: false })
    .limit(40)

  if (error) throw error
  const rows = (data ?? []) as FamilyMomentRow[]
  const uploaderIds = [...new Set(rows.map(({ uploader_id }) => uploader_id))]
  const names = new Map<string, string>()

  if (uploaderIds.length > 0) {
    const profileResult = await client
      .from('profiles')
      .select('id,display_name')
      .in('id', uploaderIds)
    if (!profileResult.error) {
      for (const profile of profileResult.data ?? []) {
        names.set(String(profile.id), String(profile.display_name))
      }
    }
  }

  const downloads = await Promise.all(
    rows.map(async (row): Promise<SavePanoramaMomentInput | null> => {
      const { data: blob, error: downloadError } = await client.storage
        .from(FAMILY_MEDIA_BUCKET)
        .download(row.panorama_path)
      if (downloadError || !blob) return null

      return {
        id: row.id,
        blob,
        label: row.caption || 'A new 360 moment',
        caption: row.caption || '',
        createdAt: row.ready_at,
        width: row.panorama_width,
        height: row.panorama_height,
        source: row.capture_kind === 'scheduled' ? 'daily' : 'manual',
        uploaderDisplayName:
          names.get(row.uploader_id) ??
          (row.uploader_id === connection.userId ? 'You' : 'Family member'),
      }
    }),
  )

  return downloads.filter(
    (moment): moment is SavePanoramaMomentInput => moment !== null,
  )
}

export function subscribeToFamilyMoments(
  circleId: string,
  onChange: () => void,
) {
  const client = getSupabaseClient()
  if (!client) return () => undefined

  const channel = client
    .channel(`family-moments:${circleId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'family_moments',
        filter: `circle_id=eq.${circleId}`,
      },
      onChange,
    )
    .subscribe()

  return () => {
    void client.removeChannel(channel)
  }
}
