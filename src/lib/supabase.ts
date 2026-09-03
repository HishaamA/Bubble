import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { appEnvironment } from './env'

export type ClerkSupabaseIdentity = {
  subject: string
  displayName?: string | null
  email?: string | null
}

export type ClerkSupabaseSession = {
  /** Return Clerk's native session token (`session.getToken()`), not a JWT template. */
  accessToken: () => Promise<string | null>
  identity: () => ClerkSupabaseIdentity | null
  signOut?: () => Promise<void>
}

const SUPABASE_AUTH_CHANGE_EVENT = 'kinsphere:supabase-auth-change'
let activeSession: (ClerkSupabaseSession & { registration: symbol }) | null =
  null

/** Notifies subscribers after the active Clerk registration changes. */
function announceAuthChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SUPABASE_AUTH_CHANGE_EVENT))
  }
}

/** Resolves the latest token instead of caching an expiring credential. */
async function resolveAccessToken() {
  return activeSession?.accessToken() ?? null
}

/**
 * Connects Clerk's current session to Supabase's native third-party auth
 * support. The cleanup is registration-safe for React Strict Mode.
 */
export function configureClerkSupabaseSession(
  session: ClerkSupabaseSession,
) {
  const registration = Symbol('clerk-supabase-session')
  activeSession = { ...session, registration }
  announceAuthChange()

  return () => {
    if (activeSession?.registration !== registration) return
    activeSession = null
    announceAuthChange()
  }
}

/** Returns the identity paired with the currently registered Clerk session. */
export function getClerkSupabaseIdentity() {
  return activeSession?.identity() ?? null
}

/** Resolves an access token from the currently registered Clerk session. */
export function getClerkSupabaseAccessToken() {
  return resolveAccessToken()
}

/** Signs out through Clerk, which remains the owner of authentication state. */
export async function signOutClerkSupabaseSession() {
  await activeSession?.signOut?.()
}

/** Subscribes a browser consumer to session registration changes. */
export function subscribeToSupabaseAuthChanges(listener: () => void) {
  if (typeof window === 'undefined') return () => undefined
  window.addEventListener(SUPABASE_AUTH_CHANGE_EVENT, listener)
  return () => window.removeEventListener(SUPABASE_AUTH_CHANGE_EVENT, listener)
}

/** Shared Supabase client, or null when the app intentionally runs locally. */
export const supabase = appEnvironment.supabase
  ? createClient(
      appEnvironment.supabase.url,
      appEnvironment.supabase.publishableKey,
      {
        // Official Clerk/Supabase native third-party authentication pattern.
        // Clerk owns session persistence and refresh; Supabase receives the
        // current asymmetric Clerk token for every Data/Storage/Realtime call.
        accessToken: resolveAccessToken,
      },
    )
  : null

/** Returns the configured client without forcing local-only callers to throw. */
export function getSupabaseClient(): SupabaseClient | null {
  return supabase
}
