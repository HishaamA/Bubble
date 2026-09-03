import { createContext, useContext } from 'react'
import type { AuthTokenGetter, AuthUser } from './types'

/** Lifecycle states exposed by every Bubble authentication implementation. */
export type AuthStatus =
  | 'unconfigured'
  | 'loading'
  | 'signed-out'
  | 'signed-in'

/** Authentication capabilities consumed by feature code. */
export type AuthContextValue = {
  status: AuthStatus
  user: AuthUser | null
  getToken: AuthTokenGetter
  signOut: () => Promise<void>
  isDevelopmentPreview?: boolean
  isTestAccess?: boolean
  startDevelopmentPreview?: () => void
}

/** Shared context; null deliberately detects consumers outside the provider. */
export const AuthContext = createContext<AuthContextValue | null>(null)

/** Returns the active authentication contract for the nearest provider. */
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider.')
  return context
}
