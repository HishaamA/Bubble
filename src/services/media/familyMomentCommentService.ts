import {
  getClerkSupabaseIdentity,
  getSupabaseClient,
} from '../../lib/supabase'
import { getFamilyMomentConnection } from './familyMomentService'

// Synced comments are server-authored. Unsynced demo comments stay local and
// are marked explicitly so callers never mistake them for family-shared data.
/** Limits shared and local comments before they reach storage. */
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

const LOCAL_STORAGE_KEY_PREFIX = 'kinsphere:family-moment-comments:v2'
const LOCAL_CHANGE_EVENT = 'kinsphere:family-moment-comment-change'
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOCAL_MOMENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/i
const ANNOTATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/
const MAX_LOCAL_COMMENTS = 500

const memoryFallbackByStorageKey = new Map<string, FamilyMomentComment[]>()
const localStorageWriteUnavailableKeys = new Set<string>()

/** Separates unsynced preview comments when a device changes accounts. */
function localCommentsStorageKey(): string {
  const accountSubject = getClerkSupabaseIdentity()?.subject?.trim()
  const accountScope = accountSubject
    ? encodeURIComponent(accountSubject)
    : 'anonymous-preview'
  return `${LOCAL_STORAGE_KEY_PREFIX}:${accountScope}`
}

/** Trims a preview author name and enforces the server-compatible limit. */
function normalizeAuthorDisplayName(value: string | null | undefined) {
  const displayName = value?.trim() || 'You'
  if (displayName.length > FAMILY_MOMENT_COMMENT_AUTHOR_MAX_LENGTH) {
    throw new TypeError(
      `Keep the comment name to ${FAMILY_MOMENT_COMMENT_AUTHOR_MAX_LENGTH} characters or fewer.`,
    )
  }
  return displayName
}

/** Canonicalizes user input before selecting remote or local persistence. */
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

/** Accepts only complete server-authored rows for the requested moment. */
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

/** Recognizes the stricter shape reserved for unsynced local comments. */
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

/** Reads validated preview comments while tolerating blocked local storage. */
function readLocalComments() {
  const storageKey = localCommentsStorageKey()
  const memoryFallback = memoryFallbackByStorageKey.get(storageKey) ?? []
  if (typeof localStorage === 'undefined') return memoryFallback
  try {
    const serializedComments = localStorage.getItem(storageKey)
    if (!serializedComments) {
      if (localStorageWriteUnavailableKeys.has(storageKey)) {
        return memoryFallback
      }
      memoryFallbackByStorageKey.set(storageKey, [])
      return []
    }
    const parsedComments: unknown = JSON.parse(serializedComments)
    if (!Array.isArray(parsedComments)) return memoryFallback
    const comments = parsedComments.filter(isLocalComment).map((comment) => ({
      ...comment,
      authorDisplayName: comment.authorDisplayName.trim(),
      body: comment.body.trim(),
      createdAt: new Date(comment.createdAt).toISOString(),
    }))
    memoryFallbackByStorageKey.set(storageKey, comments)
    return comments
  } catch {
    return memoryFallback
  }
}

/** Keeps a bounded memory mirror even when persistent browser storage fails. */
function writeLocalComments(comments: FamilyMomentComment[]) {
  const storageKey = localCommentsStorageKey()
  const memoryFallback = comments.slice(-MAX_LOCAL_COMMENTS)
  memoryFallbackByStorageKey.set(storageKey, memoryFallback)
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey, JSON.stringify(memoryFallback))
    localStorageWriteUnavailableKeys.delete(storageKey)
  } catch {
    localStorageWriteUnavailableKeys.add(storageKey)
    // The in-memory fallback still keeps preview comments working when a
    // browser blocks or exhausts localStorage.
  }
}

/** Creates a collision-resistant identifier in browsers with or without UUIDs. */
function localCommentId() {
  const randomId = globalThis.crypto?.randomUUID?.()
  return randomId ? `local-${randomId}` : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** Notifies same-document subscribers after a local or remote write. */
function announceCommentChange(momentId: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(LOCAL_CHANGE_EVENT, { detail: { momentId } }),
  )
}

/** Selects preview comments for one validated moment identifier. */
function localCommentsForMoment(momentId: string) {
  return readLocalComments().filter((comment) => comment.momentId === momentId)
}

/** Merges local and remote results by ID in chronological order. */
function sortAndDedupeComments(comments: FamilyMomentComment[]) {
  const commentsById = new Map<string, FamilyMomentComment>()
  for (const comment of comments) commentsById.set(comment.id, comment)
  return [...commentsById.values()].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  )
}

/** Resolves remote access only for synced UUID moments and signed-in members. */
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
  const remoteContext = await remoteContextForMoment(momentId)
  if (!remoteContext) return sortAndDedupeComments(localComments)

  const { data: commentRows, error } = await remoteContext.client
    .from('family_moment_comments')
    .select(
      'id,moment_id,annotation_id,author_id,author_display_name,body,created_at',
    )
    .eq('circle_id', remoteContext.connection.circleId)
    .eq('moment_id', momentId)
    .order('created_at', { ascending: true })
    .limit(250)
  if (error) throw error

  const syncedComments = ((commentRows ?? []) as FamilyMomentCommentRow[])
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
  const remoteContext = await remoteContextForMoment(normalized.momentId)

  if (remoteContext) {
    const { data: savedRows, error } = await remoteContext.client.rpc(
      'add_family_moment_comment',
      {
        p_circle_id: remoteContext.connection.circleId,
        p_moment_id: normalized.momentId,
        p_annotation_id: normalized.annotationId,
        p_body: normalized.body,
      },
    )
    if (error) throw error

    const rpcRows = Array.isArray(savedRows) ? savedRows : [savedRows]
    const savedComment = rpcRows
      .map((row) =>
        parseCommentRow(
          (row ?? {}) as FamilyMomentCommentRow,
          normalized.momentId,
        ),
      )
      .find((comment): comment is FamilyMomentComment => comment !== null)
    if (!savedComment) {
      throw new Error('The family comment could not be saved securely.')
    }
    announceCommentChange(normalized.momentId)
    return savedComment
  }

  const savedComment: FamilyMomentComment = {
    id: localCommentId(),
    momentId: normalized.momentId,
    annotationId: normalized.annotationId,
    authorId: null,
    authorDisplayName: normalized.authorDisplayName,
    body: normalized.body,
    createdAt: new Date().toISOString(),
    synced: false,
  }
  writeLocalComments([...readLocalComments(), savedComment])
  announceCommentChange(normalized.momentId)
  return savedComment
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

  // Resolve the remote channel before installing browser listeners. If the
  // membership lookup fails, the caller receives the error without leaked
  // local listeners that can no longer be cleaned up.
  const remoteContext = await remoteContextForMoment(momentId)
  const storageKey = localCommentsStorageKey()

  /** Filters same-document notifications to this subscribed moment. */
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ momentId?: unknown }>).detail
    if (detail?.momentId === momentId) onChange()
  }
  /** Filters cross-tab storage notifications to the active account namespace. */
  const onStorageChange = (event: StorageEvent) => {
    if (event.key === storageKey) onChange()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange)
    window.addEventListener('storage', onStorageChange)
  }

  const channel = remoteContext
    ? remoteContext.client
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
    if (remoteContext && channel) {
      void remoteContext.client.removeChannel(channel)
    }
  }
}
