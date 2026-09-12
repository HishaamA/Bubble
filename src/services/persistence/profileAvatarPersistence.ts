import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getClerkSupabaseIdentity,
  type ClerkSupabaseIdentity,
} from '../../lib/supabase'

type AvatarWrite = { userId: string; avatarPath: string | null; settled: Promise<void> }
const writesByClient = new WeakMap<SupabaseClient, Map<string, AvatarWrite>>()

/** Accepts only portable profile images, never credentials or local media URLs. */
function sharedAvatarPath(value: string | null | undefined): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim() || value.length > 500) return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    const path = url.toString()
    return path.length <= 500 ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * Copies Clerk's current profile photo into the existing self-update RLS path.
 * Calls are coalesced per account/image and serialized when an avatar changes;
 * failures are retryable and never block profile/family bootstrap permanently.
 */
export async function syncCurrentProfileAvatar(
  client: SupabaseClient,
  userId: string,
  identity: ClerkSupabaseIdentity,
): Promise<void> {
  const avatarPath = sharedAvatarPath(identity.imageUrl)
  if (avatarPath === undefined) return
  const writes = writesByClient.get(client) ?? new Map<string, AvatarWrite>()
  writesByClient.set(client, writes)
  const previous = writes.get(identity.subject)
  if (previous?.userId === userId && previous.avatarPath === avatarPath) {
    return previous.settled
  }

  let succeeded = false
  const entry: AvatarWrite = {
    userId,
    avatarPath,
    settled: Promise.resolve(),
  }
  entry.settled = (async () => {
    await previous?.settled
    const current = getClerkSupabaseIdentity()
    if (
      current?.subject !== identity.subject
      || sharedAvatarPath(current.imageUrl) !== avatarPath
    ) return

    // The authenticated server policy permits this update only for the JWT's
    // own internal profile. No caller-supplied family member ID is accepted.
    const { data, error } = await client.from('profiles')
      .update({ avatar_path: avatarPath })
      .eq('id', userId)
      .select('id')
      .single()
    succeeded = !error && data?.id === userId
  })().catch(() => {
    // An image is optional; keep sign-in, family reads, and uploads usable.
  }).finally(() => {
    if (!succeeded && writes.get(identity.subject) === entry) writes.delete(identity.subject)
  })
  writes.set(identity.subject, entry)
  return entry.settled
}
