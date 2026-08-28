import type { JournalPhoto } from './journalPhotoTypes'

export const demoJournalPhotos: readonly JournalPhoto[] = []

/** Keeps preview mode on the same real, account-scoped collection. */
export function withDemoJournalPhotos(
  photos: readonly JournalPhoto[],
  _demoMode: boolean,
): readonly JournalPhoto[] {
  return photos
}
