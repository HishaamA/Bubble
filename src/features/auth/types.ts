export type AuthUser = {
  id: string
  displayName: string
  email: string | null
  phone: string | null
  imageUrl: string | null
}

export type AuthTokenOptions = {
  template?: string
}

export type AuthTokenGetter = (
  options?: AuthTokenOptions,
) => Promise<string | null>
