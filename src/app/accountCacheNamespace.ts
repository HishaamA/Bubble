/**
 * Builds the storage partition used by account- and family-scoped caches.
 * Including both identifiers prevents a shared device from exposing one
 * household's offline data after another household signs in.
 */
export function createAccountCacheNamespace(userId: string, familyId: string) {
  return `${userId}:${familyId}`
}
