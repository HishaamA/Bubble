import type { Capture360Submission } from '../../features/capture'
import type {
  SavePanoramaMomentInput,
  StoredPanoramaAnnotation,
} from '../../features/memories/shared'
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

type FamilyMomentAnnotationRow = {
  id: string
  moment_id: string
  kind: 'text' | 'voice'
  pitch: number
  yaw: number
  message: string
  audio_path: string | null
  audio_mime_type: string | null
  duration_ms: number | null
  sort_order: number
}

type RemoteAnnotation = {
  id: string
  kind: 'text' | 'voice'
  pitch: number
  yaw: number
  message: string
  audio_path: string | null
  audio_mime_type: string | null
  duration_ms: number | null
}

type VoiceUpload = {
  path: string
  blob: Blob
  contentType: string
}

export type FamilyMomentSubscription = {
  ready: Promise<void>
  unsubscribe: () => void
}

export type FamilyMomentDeletion = {
  momentId: string
  mediaPaths: string[]
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ANNOTATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/

const AUDIO_EXTENSION_BY_MIME_TYPE = new Map([
  ['audio/aac', 'aac'],
  ['audio/mp4', 'm4a'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/webm', 'webm'],
])

function normalizedAudioMimeType(value: string | undefined) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function prepareRemoteAnnotations(
  connection: FamilyMomentConnection,
  momentId: string,
  annotations: StoredPanoramaAnnotation[],
) {
  if (!UUID_PATTERN.test(momentId)) {
    throw new TypeError('A family moment must have a valid UUID before upload.')
  }
  if (annotations.length > 8) {
    throw new TypeError('A family moment can contain at most eight annotations.')
  }

  const annotationIds = new Set<string>()
  const remoteAnnotations: RemoteAnnotation[] = []
  const voiceUploads: VoiceUpload[] = []

  for (const annotation of annotations) {
    const annotationId = annotation.id.trim().toLowerCase()
    if (!ANNOTATION_ID_PATTERN.test(annotationId)) {
      throw new TypeError('Every family moment annotation must have a safe ID.')
    }
    if (annotationIds.has(annotationId)) {
      throw new TypeError('Family moment annotation IDs must be unique.')
    }
    annotationIds.add(annotationId)

    if (
      !Number.isFinite(annotation.pitch) ||
      annotation.pitch < -90 ||
      annotation.pitch > 90 ||
      !Number.isFinite(annotation.yaw) ||
      annotation.yaw < -180 ||
      annotation.yaw > 180
    ) {
      throw new TypeError('Family moment annotation coordinates are out of bounds.')
    }

    const message = annotation.message.trim()
    if (!message || message.length > 180) {
      throw new TypeError(
        'Family moment annotation text must be between 1 and 180 characters.',
      )
    }

    if (annotation.kind === 'text') {
      remoteAnnotations.push({
        id: annotationId,
        kind: 'text',
        pitch: annotation.pitch,
        yaw: annotation.yaw,
        message,
        audio_path: null,
        audio_mime_type: null,
        duration_ms: null,
      })
      continue
    }

    if (annotation.kind !== 'voice' || !annotation.audioBlob) {
      throw new TypeError('Voice annotations must include an audio recording.')
    }

    const declaredMimeType = normalizedAudioMimeType(annotation.audioMimeType)
    const blobMimeType = normalizedAudioMimeType(annotation.audioBlob.type)
    if (
      declaredMimeType &&
      blobMimeType &&
      declaredMimeType !== blobMimeType
    ) {
      throw new TypeError(
        'The voice annotation audio type does not match its recording.',
      )
    }

    const contentType = declaredMimeType || blobMimeType
    const extension = AUDIO_EXTENSION_BY_MIME_TYPE.get(contentType)
    if (!extension) {
      throw new TypeError('This voice annotation audio format is not supported.')
    }

    const durationMs = annotation.durationMs
    if (
      durationMs !== undefined &&
      (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 60_000)
    ) {
      throw new TypeError('Voice annotation duration is out of bounds.')
    }

    const path = `${connection.circleId}/voice/${connection.userId}/${momentId}-${annotationId}.${extension}`
    voiceUploads.push({ path, blob: annotation.audioBlob, contentType })
    remoteAnnotations.push({
      id: annotationId,
      kind: 'voice',
      pitch: annotation.pitch,
      yaw: annotation.yaw,
      message,
      audio_path: path,
      audio_mime_type: contentType,
      duration_ms: durationMs ?? null,
    })
  }

  return { remoteAnnotations, voiceUploads }
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
  const mediaBucket = client.storage.from(FAMILY_MEDIA_BUCKET)

  const processed = await processPanoramaForSharing(submission.file)
  const panoramaPath = `${connection.circleId}/panoramas/${connection.userId}/${submission.id}.jpg`
  const thumbnailPath = `${connection.circleId}/thumbnails/${connection.userId}/${submission.id}.jpg`

  const annotations = submission.annotations ?? []
  const { remoteAnnotations, voiceUploads } = prepareRemoteAnnotations(
    connection,
    submission.id,
    annotations,
  )

  const uploads = [
    {
      path: panoramaPath,
      request: mediaBucket.upload(panoramaPath, processed.viewer, {
        cacheControl: '31536000',
        contentType: 'image/jpeg',
        upsert: false,
      }),
    },
    {
      path: thumbnailPath,
      request: mediaBucket.upload(thumbnailPath, processed.thumbnail, {
        cacheControl: '31536000',
        contentType: 'image/jpeg',
        upsert: false,
      }),
    },
    ...voiceUploads.map(({ path, blob, contentType }) => ({
      path,
      request: mediaBucket.upload(path, blob, {
        cacheControl: '31536000',
        contentType,
        upsert: false,
      }),
    })),
  ]
  const uploadResults = await Promise.allSettled(
    uploads.map(({ request }) => request),
  )
  const uploadedPaths = uploadResults.flatMap((result, index) =>
    result.status === 'fulfilled' && !result.value.error
      ? [uploads[index].path]
      : [],
  )
  const failedUpload = uploadResults.find(
    (result) => result.status === 'rejected' || Boolean(result.value.error),
  )

  async function cleanUpUnfinalizedUploads() {
    if (uploadedPaths.length === 0) return
    try {
      await mediaBucket.remove(uploadedPaths)
    } catch {
      // Storage cleanup is deliberately best-effort. The original publish
      // error is more useful, and server-side policies must prevent removal
      // after a finalization that may have succeeded despite a lost response.
    }
  }

  if (failedUpload) {
    await cleanUpUnfinalizedUploads()
    if (failedUpload.status === 'rejected') throw failedUpload.reason
    throw failedUpload.value.error
  }

  try {
    const { error } = await client.rpc(
      'finalize_360_moment_with_annotations',
      {
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
        p_annotations: remoteAnnotations,
      },
    )
    if (error) throw error
  } catch (reason) {
    await cleanUpUnfinalizedUploads()
    throw reason
  }

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
  const momentIds = rows.map(({ id }) => id)
  let annotationRows: FamilyMomentAnnotationRow[] = []

  if (momentIds.length > 0) {
    const annotationResult = await client
      .from('family_moment_annotations')
      .select(
        'id,moment_id,kind,pitch,yaw,message,audio_path,audio_mime_type,duration_ms,sort_order',
      )
      .eq('circle_id', connection.circleId)
      .in('moment_id', momentIds)
      .order('sort_order', { ascending: true })

    if (annotationResult.error) throw annotationResult.error
    annotationRows = (annotationResult.data ?? []) as FamilyMomentAnnotationRow[]
  }

  const annotationsByMoment = new Map<string, FamilyMomentAnnotationRow[]>()
  for (const annotation of annotationRows) {
    const current = annotationsByMoment.get(annotation.moment_id) ?? []
    current.push(annotation)
    annotationsByMoment.set(annotation.moment_id, current)
  }

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
      const persistedAnnotations = annotationsByMoment.get(row.id) ?? []
      const [panoramaDownload, downloadedAnnotations] = await Promise.all([
        client.storage.from(FAMILY_MEDIA_BUCKET).download(row.panorama_path),
        Promise.all(
          persistedAnnotations.map(
            async (annotation): Promise<StoredPanoramaAnnotation> => {
              const base: StoredPanoramaAnnotation = {
                id: annotation.id,
                kind: annotation.kind,
                pitch: Number(annotation.pitch),
                yaw: Number(annotation.yaw),
                message: annotation.message,
              }

              if (annotation.kind === 'text') return base
              if (!annotation.audio_path) return base

              try {
                const audioDownload = await client.storage
                  .from(FAMILY_MEDIA_BUCKET)
                  .download(annotation.audio_path)
                if (audioDownload.error || !audioDownload.data) return base

                return {
                  ...base,
                  kind: 'voice',
                  audioBlob: audioDownload.data,
                  audioMimeType:
                    annotation.audio_mime_type || audioDownload.data.type,
                  durationMs: annotation.duration_ms ?? undefined,
                }
              } catch {
                return base
              }
            },
          ),
        ),
      ])
      if (panoramaDownload.error || !panoramaDownload.data) return null

      return {
        id: row.id,
        blob: panoramaDownload.data,
        label: row.caption || 'A new 360 moment',
        caption: row.caption || '',
        createdAt: row.ready_at,
        width: row.panorama_width,
        height: row.panorama_height,
        source: row.capture_kind === 'scheduled' ? 'daily' : 'manual',
        uploaderDisplayName:
          row.uploader_id === connection.userId
            ? 'You'
            : names.get(row.uploader_id) ?? 'Family member',
        ownedByCurrentUser: row.uploader_id === connection.userId,
        familySynced: true,
        annotations: downloadedAnnotations,
      }
    }),
  )

  return downloads.filter(
    (moment): moment is SavePanoramaMomentInput => moment !== null,
  )
}

export async function fetchFamilyMomentDeletionIds(
  connection: FamilyMomentConnection,
  cachedMomentIds: readonly string[],
): Promise<string[]> {
  const client = getSupabaseClient()
  if (!client) return []
  const candidateIds = [
    ...new Set(cachedMomentIds.filter((id) => UUID_PATTERN.test(id))),
  ]
  if (candidateIds.length === 0) return []

  const chunks = Array.from(
    { length: Math.ceil(candidateIds.length / 100) },
    (_, index) => candidateIds.slice(index * 100, index * 100 + 100),
  )
  const results = await Promise.all(
    chunks.map(async (ids) => {
      const { data, error } = await client
        .from('family_moment_deletions')
        .select('moment_id')
        .eq('circle_id', connection.circleId)
        .in('moment_id', ids)
      if (error) throw error
      return data ?? []
    }),
  )

  return results.flat().flatMap((row) => {
    if (!row || typeof row !== 'object' || !('moment_id' in row)) return []
    const momentId = String(row.moment_id)
    return UUID_PATTERN.test(momentId) ? [momentId] : []
  })
}

function parseFamilyMomentDeletions(data: unknown): FamilyMomentDeletion[] {
  const rows = Array.isArray(data) ? data : data ? [data] : []
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const record = row as { moment_id?: unknown; media_paths?: unknown }
    const momentId = String(record.moment_id ?? '')
    if (!UUID_PATTERN.test(momentId) || !Array.isArray(record.media_paths)) {
      return []
    }
    const mediaPaths = record.media_paths.filter(
      (path): path is string => typeof path === 'string' && path.length > 0,
    )
    return [{ momentId, mediaPaths }]
  })
}

async function completeFamilyMomentDeletion(
  connection: FamilyMomentConnection,
  deletion: FamilyMomentDeletion,
) {
  const client = getSupabaseClient()
  if (!client) throw new Error('Family sync is not configured.')

  if (deletion.mediaPaths.length > 0) {
    const removal = await client.storage
      .from(FAMILY_MEDIA_BUCKET)
      .remove(deletion.mediaPaths)
    if (removal.error) throw removal.error
  }

  const { error } = await client.rpc('finish_delete_own_family_moment', {
    p_circle_id: connection.circleId,
    p_moment_id: deletion.momentId,
  })
  if (error) throw error
}

/**
 * Records the deletion for every family device before cleaning private media.
 * Once the tombstone exists the post is logically deleted; interrupted media
 * cleanup is intentionally retried by resumePendingFamilyMomentDeletions.
 */
export async function deleteFamilyMoment(
  connection: FamilyMomentConnection,
  momentId: string,
): Promise<{ cleanupPending: boolean }> {
  if (!UUID_PATTERN.test(momentId)) {
    throw new TypeError('A family moment must have a valid UUID before deletion.')
  }
  const client = getSupabaseClient()
  if (!client) throw new Error('Family sync is not configured.')

  const { data, error } = await client.rpc('begin_delete_own_family_moment', {
    p_circle_id: connection.circleId,
    p_moment_id: momentId,
  })
  if (error) throw error

  const deletion = parseFamilyMomentDeletions(data)[0]
  if (!deletion) {
    throw new Error('The family deletion could not be confirmed securely.')
  }

  try {
    await completeFamilyMomentDeletion(connection, deletion)
    return { cleanupPending: false }
  } catch {
    // The durable tombstone already removed the post for the family. Keep the
    // pending row so this device can safely resume Storage cleanup on reconnect.
    return { cleanupPending: true }
  }
}

export async function resumePendingFamilyMomentDeletions(
  connection: FamilyMomentConnection,
): Promise<void> {
  const client = getSupabaseClient()
  if (!client) return

  const { data, error } = await client.rpc(
    'list_pending_own_family_moment_deletions',
    { p_circle_id: connection.circleId },
  )
  if (error) throw error

  const pending = parseFamilyMomentDeletions(data)
  const results = await Promise.allSettled(
    pending.map((deletion) =>
      completeFamilyMomentDeletion(connection, deletion),
    ),
  )
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failure) throw failure.reason
}

export function subscribeToFamilyMoments(
  circleId: string,
  onChange: (deletedMomentId?: string) => void,
): FamilyMomentSubscription {
  const client = getSupabaseClient()
  if (!client) {
    return {
      ready: Promise.resolve(),
      unsubscribe: () => undefined,
    }
  }

  let resolveReady: () => void
  let rejectReady: (reason: Error) => void
  let readySettled = false
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

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
      () => onChange(),
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'family_moment_deletions',
        filter: `circle_id=eq.${circleId}`,
      },
      (payload) => {
        const record = payload.new as { moment_id?: unknown } | null
        const momentId = String(record?.moment_id ?? '')
        onChange(UUID_PATTERN.test(momentId) ? momentId : undefined)
      },
    )
    .subscribe((status, error) => {
      if (readySettled) return
      if (status === 'SUBSCRIBED') {
        readySettled = true
        resolveReady()
        return
      }
      if (
        status === 'CHANNEL_ERROR' ||
        status === 'TIMED_OUT' ||
        status === 'CLOSED'
      ) {
        readySettled = true
        rejectReady(
          error ?? new Error('Family moment updates could not connect.'),
        )
      }
    })

  return {
    ready,
    unsubscribe: () => {
      if (!readySettled) {
        readySettled = true
        rejectReady(new Error('Family moment updates were disconnected.'))
      }
      void client.removeChannel(channel)
    },
  }
}
