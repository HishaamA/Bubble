import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const clerk = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  sessionId: 'session_A',
  user: null as null | {
    id: string
    fullName: string
    firstName: string
    primaryEmailAddress: { emailAddress: string }
    emailAddresses: Array<{ emailAddress: string }>
    primaryPhoneNumber: null
    phoneNumbers: Array<{ phoneNumber: string }>
    imageUrl: string
  },
  getToken: vi.fn(async () => 'clerk-token'),
  signOut: vi.fn(async () => undefined),
  client: null as null | { signOut: () => Promise<void> },
  configure: vi.fn(),
  cleanups: [] as Array<ReturnType<typeof vi.fn>>,
}))

const flightNotifications = vi.hoisted(() => ({
  cancelActiveSubjectFlightNotifications: vi.fn(async () => undefined),
}))

vi.mock('@clerk/react', () => ({
  useAuth: () => ({
    getToken: clerk.getToken,
    isLoaded: clerk.isLoaded,
    isSignedIn: clerk.isSignedIn,
    sessionId: clerk.sessionId,
  }),
  useClerk: () => clerk.client,
  useUser: () => ({ user: clerk.user }),
}))

vi.mock('../../lib/supabase', () => ({
  configureClerkSupabaseSession: clerk.configure,
}))
vi.mock('../flights/flightNotifications', () => flightNotifications)

import { ClerkAuthBridge } from './AuthProvider'
import { useAuth } from './authContext'

function clerkUser(id: string, name: string) {
  return {
    id,
    fullName: name,
    firstName: name.split(' ')[0],
    primaryEmailAddress: { emailAddress: `${id}@example.com` },
    emailAddresses: [{ emailAddress: `${id}@example.com` }],
    primaryPhoneNumber: null,
    phoneNumbers: [],
    imageUrl: `https://images.example/${id}.jpg`,
  }
}

function AuthProbe({ observations }: { observations: string[] }) {
  const { status, user } = useAuth()
  const observation = `${status}:${user?.id ?? 'none'}`
  observations.push(observation)
  return <output aria-label="Auth bridge state">{observation}</output>
}

beforeEach(() => {
  vi.clearAllMocks()
  clerk.isLoaded = true
  clerk.isSignedIn = true
  clerk.sessionId = 'session_A'
  clerk.user = clerkUser('user_A', 'Amina Ahmed')
  clerk.client = { signOut: clerk.signOut }
  clerk.cleanups.length = 0
  clerk.configure.mockImplementation(() => {
    const cleanup = vi.fn()
    clerk.cleanups.push(cleanup)
    return cleanup
  })
})

describe('ClerkAuthBridge', () => {
  it('registers Clerk with Supabase before publishing a signed-in user', async () => {
    const observations: string[] = []
    render(
      <ClerkAuthBridge>
        <AuthProbe observations={observations} />
      </ClerkAuthBridge>,
    )

    expect(observations[0]).toBe('loading:none')
    expect(
      await screen.findByText('signed-in:user_A'),
    ).toBeInTheDocument()
    expect(clerk.configure).toHaveBeenCalledTimes(1)

    const session = clerk.configure.mock.calls[0][0] as {
      accessToken: () => Promise<string | null>
      identity: () => { subject: string; displayName: string; email: string }
      signOut: () => Promise<void>
    }
    expect(session.identity()).toEqual({
      subject: 'user_A',
      displayName: 'Amina Ahmed',
      email: 'user_A@example.com',
    })
    await expect(session.accessToken()).resolves.toBe('clerk-token')
    await session.signOut()
    expect(flightNotifications.cancelActiveSubjectFlightNotifications)
      .toHaveBeenCalledTimes(1)
    expect(clerk.signOut).toHaveBeenCalledTimes(1)
  })

  it('clears active-subject flight alerts when Clerk signs out externally', async () => {
    const observations: string[] = []
    const view = render(
      <ClerkAuthBridge>
        <AuthProbe observations={observations} />
      </ClerkAuthBridge>,
    )
    await screen.findByText('signed-in:user_A')
    flightNotifications.cancelActiveSubjectFlightNotifications.mockClear()

    clerk.isSignedIn = false
    clerk.sessionId = null as unknown as string
    clerk.user = null
    view.rerender(
      <ClerkAuthBridge>
        <AuthProbe observations={observations} />
      </ClerkAuthBridge>,
    )

    await waitFor(() => expect(
      flightNotifications.cancelActiveSubjectFlightNotifications,
    ).toHaveBeenCalledTimes(1))
  })

  it('returns to loading while replacing account A with account B', async () => {
    const observations: string[] = []
    const view = render(
      <ClerkAuthBridge>
        <AuthProbe observations={observations} />
      </ClerkAuthBridge>,
    )
    await screen.findByText('signed-in:user_A')
    observations.length = 0

    clerk.user = clerkUser('user_B', 'Bilal Ahmed')
    clerk.sessionId = 'session_B'
    view.rerender(
      <ClerkAuthBridge>
        <AuthProbe observations={observations} />
      </ClerkAuthBridge>,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('Auth bridge state')).toHaveTextContent(
        'signed-in:user_B',
      ),
    )
    expect(observations[0]).toBe('loading:none')
    expect(observations).toContain('signed-in:user_B')
    expect(clerk.cleanups[0]).toHaveBeenCalledTimes(1)
    const replacement = clerk.configure.mock.calls.at(-1)?.[0] as {
      identity: () => { subject: string }
    }
    expect(replacement.identity().subject).toBe('user_B')
  })

  it('leaves one usable registration after React Strict Mode replays effects', async () => {
    const observations: string[] = []
    render(
      <StrictMode>
        <ClerkAuthBridge>
          <AuthProbe observations={observations} />
        </ClerkAuthBridge>
      </StrictMode>,
    )

    expect(await screen.findByText('signed-in:user_A')).toBeInTheDocument()
    expect(clerk.configure.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(clerk.cleanups[0]).toHaveBeenCalledTimes(1)
    expect(clerk.cleanups.at(-1)).not.toHaveBeenCalled()
  })
})
