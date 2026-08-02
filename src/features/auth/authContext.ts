import { createContext, useContext } from 'react'
import type { AuthTokenGetter, AuthUser } from './types'

export type AuthStatus =
  | 'unconfigured'
  | 'loading'
  | 'signed-out'
  | 'signed-in'

export type AuthContextValue = {
  status: AuthStatus
  user: AuthUser | null
  getToken: AuthTokenGetter
  signOut: () => Promise<void>
  isDevelopmentPreview?: boolean
  startDevelopmentPreview?: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider.')
  return context
}
