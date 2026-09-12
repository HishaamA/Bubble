import { getJournalFamilyContext } from './journalPhotoService'
import type { JournalPhotoDeletion } from './journalPhotoTypes'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Removes only an authenticated uploader's Journal row; the server checks ownership. */
export async function deleteFamilyJournalPhoto(photoId: string, cacheNamespace: string): Promise<void> {
  if (!uuid.test(photoId)) throw new Error('Choose a valid Journal photo.')
  // These imports have never belonged to a shared family library.
  if (cacheNamespace.endsWith(':no-family')) return
  const context = await getJournalFamilyContext(cacheNamespace)
  if (!context || !context.isCurrent()) throw new Error('Reconnect to your family before deleting this photo.')
  const { data, error } = await context.client.rpc('delete_family_journal_photo', {
    p_circle_id: context.circleId,
    p_photo_id: photoId,
  })
  if (error || data !== true) {
    throw new Error('This photo could not be deleted. Check your connection and try again.')
  }
  if (!context.isCurrent()) return
  // Never derive deletion paths from a signed URL or arbitrary caller input.
  // The existing Storage policy permits only this uploader's unreferenced files.
  await context.client.storage.from('family-media').remove([
    `${context.circleId}/journal-images/${context.userId}/${photoId}.jpg`,
    `${context.circleId}/journal-thumbnails/${context.userId}/${photoId}.jpg`,
  ]).catch(() => undefined)
}

/** Reads explicit server tombstones, never treating a partial photo list as deletion. */
export async function fetchDeletedJournalPhotos(cacheNamespace: string): Promise<JournalPhotoDeletion[] | null> {
  const context = await getJournalFamilyContext(cacheNamespace)
  if (!context) return null
  const deletions = new Map<string, JournalPhotoDeletion>()
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await context.client.from('deleted_family_journal_photos')
      .select('photo_id,uploader_id').eq('circle_id', context.circleId)
      .order('photo_id').order('uploader_id').range(offset, offset + 499)
    if (error) throw error
    if (!context.isCurrent()) return null
    for (const row of data ?? []) {
      if (typeof row.photo_id !== 'string' || !uuid.test(row.photo_id) ||
        typeof row.uploader_id !== 'string' || !uuid.test(row.uploader_id)) continue
      deletions.set(`${row.photo_id}:${row.uploader_id}`, {
        photoId: row.photo_id,
        uploaderId: row.uploader_id,
        ownedByCurrentUser: row.uploader_id === context.userId,
      })
    }
    if ((data?.length ?? 0) < 500) return [...deletions.values()]
  }
}

/** A separate channel lets older deployments keep normal photo subscriptions working. */
export async function subscribeToJournalPhotoDeletions(onChange: () => void, cacheNamespace: string) {
  const context = await getJournalFamilyContext(cacheNamespace)
  if (!context) return () => undefined
  const channel = context.client.channel(`journal-photo-deletions:${context.circleId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'deleted_family_journal_photos',
      filter: `circle_id=eq.${context.circleId}`,
    }, () => { if (context.isCurrent()) onChange() })
    .subscribe()
  return () => { void context.client.removeChannel(channel) }
}
