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

function announceAuthChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SUPABASE_AUTH_CHANGE_EVENT))
  }
}

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

export function getClerkSupabaseIdentity() {
  return activeSession?.identity() ?? null
}

export function getClerkSupabaseAccessToken() {
  return resolveAccessToken()
}

export async function signOutClerkSupabaseSession() {
  await activeSession?.signOut?.()
}

export function subscribeToSupabaseAuthChanges(listener: () => void) {
  if (typeof window === 'undefined') return () => undefined
  window.addEventListener(SUPABASE_AUTH_CHANGE_EVENT, listener)
  return () => window.removeEventListener(SUPABASE_AUTH_CHANGE_EVENT, listener)
}

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

export function getSupabaseClient(): SupabaseClient | null {
  return supabase
}
