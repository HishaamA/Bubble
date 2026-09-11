import { getClerkSupabaseIdentity, getSupabaseClient } from '../../lib/supabase'
import { bootstrapCurrentClerkProfile } from '../../services/persistence'

export const PHOTO_REACTION_EMOJIS = ['❤️', '🥰', '😂', '😮', '👏'] as const

export type PhotoReactionSummary = {
  emoji: string
  count: number
  reactedByMe: boolean
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
let subscriptionSequence = 0

function normalizePhotoId(photoId: string) {
  const id = photoId.trim().toLowerCase()
  if (!UUID_PATTERN.test(id)) {
    throw new TypeError('Choose a shared capsule photo before reacting.')
  }
  return id
}

function isReactionEmoji(value: unknown): value is typeof PHOTO_REACTION_EMOJIS[number] {
  return typeof value === 'string' && PHOTO_REACTION_EMOJIS.some((emoji) => emoji === value)
}

/** Backend counts are scoped to the requested photo and current signed-in user. */
function parseReactions(value: unknown): PhotoReactionSummary[] {
  if (!Array.isArray(value)) throw new Error('The photo reactions could not be loaded.')
  const reactions = new Map<string, PhotoReactionSummary>()
  for (const row of value) {
    if (!row || typeof row !== 'object') continue
    const { emoji, reaction_count: count, reacted_by_me: reactedByMe } = row
    if (
      !isReactionEmoji(emoji) ||
      !Number.isSafeInteger(count) || count <= 0 ||
      typeof reactedByMe !== 'boolean'
    ) continue
    reactions.set(emoji, { emoji, count, reactedByMe })
  }
  return PHOTO_REACTION_EMOJIS.flatMap((emoji) => {
    const reaction = reactions.get(emoji)
    return reaction ? [reaction] : []
  })
}

async function reactionClient() {
  const client = getSupabaseClient()
  if (!client || !getClerkSupabaseIdentity()) {
    throw new Error('Sign in to react with your family.')
  }
  await bootstrapCurrentClerkProfile()
  return client
}

/** Reads family counts only after the server checks membership and capsule unlock. */
export async function fetchPhotoReactions(photoId: string): Promise<PhotoReactionSummary[]> {
  const id = normalizePhotoId(photoId)
  const client = await reactionClient()
  const { data, error } = await client.rpc('list_capsule_photo_reactions', { p_item_id: id })
  if (error) throw error
  return parseReactions(data)
}

/** Sets one reaction per member. Pass null to remove the member's current reaction. */
export async function setPhotoReaction(
  photoId: string,
  emoji: string | null,
): Promise<PhotoReactionSummary[]> {
  const id = normalizePhotoId(photoId)
  if (emoji !== null && !isReactionEmoji(emoji)) {
    throw new TypeError('Choose one of the available photo reactions.')
  }
  const client = await reactionClient()
  const { data, error } = await client.rpc('set_capsule_photo_reaction', {
    p_item_id: id,
    p_emoji: emoji,
  })
  if (error) throw error
  return parseReactions(data)
}

/** Realtime sends no reaction data to UI; each refresh rechecks current access. */
export function subscribeToPhotoReactions(photoId: string, onChange: () => void): () => void {
  const client = getSupabaseClient()
  if (!client || !getClerkSupabaseIdentity() || !UUID_PATTERN.test(photoId.trim())) {
    return () => undefined
  }
  const id = normalizePhotoId(photoId)
  const channel = client
    .channel(`capsule-photo-reactions:${id}:${++subscriptionSequence}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'family_capsule_photo_reactions',
      filter: `item_id=eq.${id}`,
    }, onChange)
    .subscribe()
  return () => { void client.removeChannel(channel) }
}
