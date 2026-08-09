import {
  getClerkSupabaseIdentity,
  getSupabaseClient,
} from '../../lib/supabase'
import { getFamilyMomentConnection } from './familyMomentService'

export const FAMILY_MOMENT_COMMENT_MAX_LENGTH = 500
export const FAMILY_MOMENT_COMMENT_AUTHOR_MAX_LENGTH = 80

export type FamilyMomentComment = {
  id: string
  momentId: string
  /** Null targets the whole panorama; otherwise this is an embedded note ID. */
  annotationId: string | null
  /** Null for local preview comments that have no durable app-user identity. */
  authorId: string | null
  authorDisplayName: string
  body: string
  createdAt: string
  synced: boolean
}

export type AddFamilyMomentCommentInput = {
  momentId: string
  /** Omit or pass null to comment on the whole panorama. */
  annotationId?: string | null
  body: string
  /** Used only by the local preview fallback. The backend derives its own name. */
  authorDisplayName?: string
}

type FamilyMomentCommentRow = {
  id?: unknown
  moment_id?: unknown
  annotation_id?: unknown
  author_id?: unknown
  author_display_name?: unknown
  body?: unknown
  created_at?: unknown
}

type NormalizedCommentInput = {
  momentId: string
  annotationId: string | null
  body: string
  authorDisplayName: string
}

const LOCAL_STORAGE_KEY = 'kinsphere:family-moment-comments:v1'
const LOCAL_CHANGE_EVENT = 'kinsphere:family-moment-comment-change'
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOCAL_MOMENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/i
const ANNOTATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/
const MAX_LOCAL_COMMENTS = 500

let memoryFallback: FamilyMomentComment[] = []
let localStorageWriteUnavailable = false

function normalizeAuthorDisplayName(value: string | null | undefined) {
  const displayName = value?.trim() || 'You'
  if (displayName.length > FAMILY_MOMENT_COMMENT_AUTHOR_MAX_LENGTH) {
    throw new TypeError(
      `Keep the comment name to ${FAMILY_MOMENT_COMMENT_AUTHOR_MAX_LENGTH} characters or fewer.`,
    )
  }
  return displayName
}

function normalizeCommentInput(
  input: AddFamilyMomentCommentInput,
): NormalizedCommentInput {
  const momentId = input.momentId.trim()
  if (!LOCAL_MOMENT_ID_PATTERN.test(momentId)) {
    throw new TypeError('Choose a valid family moment before commenting.')
  }

  const annotationId = input.annotationId?.trim().toLowerCase() || null
  if (annotationId && !ANNOTATION_ID_PATTERN.test(annotationId)) {
    throw new TypeError('Choose a valid embedded note before replying.')
  }

  const body = input.body.trim()
  if (!body || body.length > FAMILY_MOMENT_COMMENT_MAX_LENGTH) {
    throw new TypeError(
      `Keep comments between 1 and ${FAMILY_MOMENT_COMMENT_MAX_LENGTH} characters.`,
    )
  }

  return {
    momentId,
    annotationId,
    body,
    authorDisplayName: normalizeAuthorDisplayName(
      input.authorDisplayName ?? getClerkSupabaseIdentity()?.displayName,
    ),
  }
}

function parseCommentRow(
  row: FamilyMomentCommentRow,
  expectedMomentId?: string,
): FamilyMomentComment | null {
  if (
    typeof row.id !== 'string' ||
    !UUID_PATTERN.test(row.id) ||
    typeof row.moment_id !== 'string' ||
    !UUID_PATTERN.test(row.moment_id) ||
    (expectedMomentId !== undefined && row.moment_id !== expectedMomentId) ||
    typeof row.author_id !== 'string' ||
    !UUID_PATTERN.test(row.author_id) ||
    typeof row.author_display_name !== 'string' ||
    !row.author_display_name.trim() ||
    row.author_display_name.trim().length >
      FAMILY_MOMENT_COMMENT_AUTHOR_MAX_LENGTH ||
    typeof row.body !== 'string' ||
    !row.body.trim() ||
    row.body.trim().length > FAMILY_MOMENT_COMMENT_MAX_LENGTH ||
    typeof row.created_at !== 'string'
  ) {
    return null
  }

  const createdAt = new Date(row.created_at)
  if (Number.isNaN(createdAt.getTime())) return null

  let annotationId: string | null = null
  if (row.annotation_id !== null && row.annotation_id !== undefined) {
    if (
      typeof row.annotation_id !== 'string' ||
      !ANNOTATION_ID_PATTERN.test(row.annotation_id)
    ) {
      return null
    }
    annotationId = row.annotation_id
  }

  return {
    id: row.id,
    momentId: row.moment_id,
    annotationId,
    authorId: row.author_id,
    authorDisplayName: row.author_display_name.trim(),
    body: row.body.trim(),
    createdAt: createdAt.toISOString(),
    synced: true,
  }
}

function isLocalComment(value: unknown): value is FamilyMomentComment {
  if (!value || typeof value !== 'object') return false
  const comment = value as Partial<FamilyMomentComment>
  return (
    typeof comment.id === 'string' &&
    LOCAL_MOMENT_ID_PATTERN.test(comment.id) &&
    typeof comment.momentId === 'string' &&
    LOCAL_MOMENT_ID_PATTERN.test(comment.momentId) &&
    (comment.annotationId === null ||
      (typeof comment.annotationId === 'string' &&
        ANNOTATION_ID_PATTERN.test(comment.annotationId))) &&
    comment.authorId === null &&
    typeof comment.authorDisplayName === 'string' &&
    Boolean(comment.authorDisplayName.trim()) &&
    comment.authorDisplayName.trim().length <=
      FAMILY_MOMENT_COMMENT_AUTHOR_MAX_LENGTH &&
    typeof comment.body === 'string' &&
    Boolean(comment.body.trim()) &&
    comment.body.trim().length <= FAMILY_MOMENT_COMMENT_MAX_LENGTH &&
    typeof comment.createdAt === 'string' &&
    !Number.isNaN(new Date(comment.createdAt).getTime()) &&
    comment.synced === false
  )
}

function readLocalComments() {
  if (typeof localStorage === 'undefined') return memoryFallback
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) {
      if (localStorageWriteUnavailable) return memoryFallback
      memoryFallback = []
      return memoryFallback
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return memoryFallback
    const comments = parsed.filter(isLocalComment).map((comment) => ({
      ...comment,
      authorDisplayName: comment.authorDisplayName.trim(),
      body: comment.body.trim(),
      createdAt: new Date(comment.createdAt).toISOString(),
    }))
    memoryFallback = comments
    return comments
  } catch {
    return memoryFallback
  }
}

function writeLocalComments(comments: FamilyMomentComment[]) {
  memoryFallback = comments.slice(-MAX_LOCAL_COMMENTS)
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(memoryFallback))
    localStorageWriteUnavailable = false
  } catch {
    localStorageWriteUnavailable = true
    // The in-memory fallback still keeps preview comments working when a
    // browser blocks or exhausts localStorage.
  }
}

function localCommentId() {
  const randomId = globalThis.crypto?.randomUUID?.()
  return randomId ? `local-${randomId}` : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function announceCommentChange(momentId: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(LOCAL_CHANGE_EVENT, { detail: { momentId } }),
  )
}

function localCommentsForMoment(momentId: string) {
  return readLocalComments().filter((comment) => comment.momentId === momentId)
}

function sortAndDedupeComments(comments: FamilyMomentComment[]) {
  const byId = new Map<string, FamilyMomentComment>()
  for (const comment of comments) byId.set(comment.id, comment)
  return [...byId.values()].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  )
}

async function remoteContextForMoment(momentId: string) {
  if (!UUID_PATTERN.test(momentId)) return null
  const client = getSupabaseClient()
  if (!client || !getClerkSupabaseIdentity()) return null
  const connection = await getFamilyMomentConnection()
  return connection ? { client, connection } : null
}

/** Loads whole-photo comments and embedded-note replies in chronological order. */
export async function fetchFamilyMomentComments(
  momentIdInput: string,
): Promise<FamilyMomentComment[]> {
  const momentId = momentIdInput.trim()
  if (!LOCAL_MOMENT_ID_PATTERN.test(momentId)) return []

  const localComments = localCommentsForMoment(momentId)
  const remote = await remoteContextForMoment(momentId)
  if (!remote) return sortAndDedupeComments(localComments)

  const { data, error } = await remote.client
    .from('family_moment_comments')
    .select(
      'id,moment_id,annotation_id,author_id,author_display_name,body,created_at',
    )
    .eq('circle_id', remote.connection.circleId)
    .eq('moment_id', momentId)
    .order('created_at', { ascending: true })
    .limit(250)
  if (error) throw error

  const syncedComments = ((data ?? []) as FamilyMomentCommentRow[])
    .map((row) => parseCommentRow(row, momentId))
    .filter((comment): comment is FamilyMomentComment => comment !== null)

  return sortAndDedupeComments([...localComments, ...syncedComments])
}

/**
 * Persists to the family backend when this is a synced UUID moment and an
 * approved family connection exists; otherwise saves a durable local preview.
 */
export async function addFamilyMomentComment(
  input: AddFamilyMomentCommentInput,
): Promise<FamilyMomentComment> {
  const normalized = normalizeCommentInput(input)
  const remote = await remoteContextForMoment(normalized.momentId)

  if (remote) {
    const { data, error } = await remote.client.rpc('add_family_moment_comment', {
      p_circle_id: remote.connection.circleId,
      p_moment_id: normalized.momentId,
      p_annotation_id: normalized.annotationId,
      p_body: normalized.body,
    })
    if (error) throw error

    const rows = Array.isArray(data) ? data : [data]
    const saved = rows
      .map((row) => parseCommentRow((row ?? {}) as FamilyMomentCommentRow, normalized.momentId))
      .find((comment): comment is FamilyMomentComment => comment !== null)
    if (!saved) {
      throw new Error('The family comment could not be saved securely.')
    }
    announceCommentChange(normalized.momentId)
    return saved
  }

  const saved: FamilyMomentComment = {
    id: localCommentId(),
    momentId: normalized.momentId,
    annotationId: normalized.annotationId,
    authorId: null,
    authorDisplayName: normalized.authorDisplayName,
    body: normalized.body,
    createdAt: new Date().toISOString(),
    synced: false,
  }
  writeLocalComments([...readLocalComments(), saved])
  announceCommentChange(normalized.momentId)
  return saved
}

/**
 * Watches both Supabase Realtime and the local preview store. Await the result
 * once in an effect, then call the returned cleanup function on unmount.
 */
export async function subscribeToFamilyMomentComments(
  momentIdInput: string,
  onChange: () => void,
): Promise<() => void> {
  const momentId = momentIdInput.trim()
  if (!LOCAL_MOMENT_ID_PATTERN.test(momentId)) return () => undefined

  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ momentId?: unknown }>).detail
    if (detail?.momentId === momentId) onChange()
  }
  const onStorageChange = (event: StorageEvent) => {
    if (event.key === LOCAL_STORAGE_KEY) onChange()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange)
    window.addEventListener('storage', onStorageChange)
  }

  const remote = await remoteContextForMoment(momentId)
  const channel = remote
    ? remote.client
        .channel(`family-moment-comments:${momentId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'family_moment_comments',
            filter: `moment_id=eq.${momentId}`,
          },
          onChange,
        )
        .subscribe()
    : null

  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange)
      window.removeEventListener('storage', onStorageChange)
    }
    if (remote && channel) void remote.client.removeChannel(channel)
  }
}
