/** Minimal authenticated identity shared with product features. */
export type AuthUser = {
  id: string
  displayName: string
  email: string | null
  phone: string | null
  imageUrl: string | null
}

/** Optional Clerk token-template selection passed through feature calls. */
export type AuthTokenOptions = {
  template?: string
}

/** Retrieves a current bearer token, or null for local-only sessions. */
export type AuthTokenGetter = (
  options?: AuthTokenOptions,
) => Promise<string | null>
