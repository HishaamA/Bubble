import { describe, expect, it, vi } from 'vitest'
import {
  configureClerkSupabaseSession,
  getClerkSupabaseAccessToken,
  getClerkSupabaseIdentity,
  subscribeToSupabaseAuthChanges,
} from './supabase'

describe('Clerk Supabase session bridge', () => {
  it('provides the live Clerk token and identity to the shared client', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToSupabaseAuthChanges(listener)
    const cleanup = configureClerkSupabaseSession({
      accessToken: async () => 'clerk-session-token',
      identity: () => ({
        subject: 'user_clerk_alice',
        displayName: 'Alice',
        email: 'alice@example.test',
      }),
    })

    await expect(getClerkSupabaseAccessToken()).resolves.toBe(
      'clerk-session-token',
    )
    expect(getClerkSupabaseIdentity()).toEqual({
      subject: 'user_clerk_alice',
      displayName: 'Alice',
      email: 'alice@example.test',
    })
    expect(listener).toHaveBeenCalledTimes(1)

    cleanup()
    await expect(getClerkSupabaseAccessToken()).resolves.toBeNull()
    expect(getClerkSupabaseIdentity()).toBeNull()
    unsubscribe()
  })

  it('does not let a stale Strict Mode cleanup remove a newer session', async () => {
    const cleanupFirst = configureClerkSupabaseSession({
      accessToken: async () => 'first-token',
      identity: () => ({ subject: 'user_first' }),
    })
    const cleanupSecond = configureClerkSupabaseSession({
      accessToken: async () => 'second-token',
      identity: () => ({ subject: 'user_second' }),
    })

    cleanupFirst()
    await expect(getClerkSupabaseAccessToken()).resolves.toBe('second-token')
    expect(getClerkSupabaseIdentity()?.subject).toBe('user_second')

    cleanupSecond()
  })
})
