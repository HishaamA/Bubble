import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const coordinatorMocks = vi.hoisted(() => ({
  auth: {
    status: 'signed-in' as 'signed-in' | 'signed-out' | 'loading',
    user: { id: 'user_a' } as { id: string } | null,
  },
  listener: undefined as ((state: { isActive: boolean }) => void) | undefined,
  addListener: vi.fn(),
  remove: vi.fn(),
  transition: vi.fn(),
  resume: vi.fn(),
}))

vi.mock('../auth', () => ({
  useAuth: () => coordinatorMocks.auth,
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: coordinatorMocks.addListener,
  },
}))

vi.mock('./eventReminders', () => ({
  transitionEventReminderAccount: coordinatorMocks.transition,
  resumeEventReminderAccount: coordinatorMocks.resume,
}))

import { EventReminderCoordinator } from './EventReminderCoordinator'

beforeEach(() => {
  vi.clearAllMocks()
  coordinatorMocks.auth.status = 'signed-in'
  coordinatorMocks.auth.user = { id: 'user_a' }
  coordinatorMocks.listener = undefined
  coordinatorMocks.addListener.mockImplementation(
    async (_eventName: string, listener: (state: { isActive: boolean }) => void) => {
      coordinatorMocks.listener = listener
      return { remove: coordinatorMocks.remove }
    },
  )
  coordinatorMocks.transition.mockResolvedValue(undefined)
  coordinatorMocks.resume.mockResolvedValue(undefined)
})

describe('EventReminderCoordinator', () => {
  it('reconciles globally on account activation and native resume', async () => {
    render(<EventReminderCoordinator />)

    await waitFor(() => {
      expect(coordinatorMocks.transition).toHaveBeenCalledWith('user_a')
      expect(coordinatorMocks.listener).toBeTypeOf('function')
    })
    coordinatorMocks.listener?.({ isActive: true })

    expect(coordinatorMocks.resume).toHaveBeenCalledWith('user_a')
  })

  it('transitions to no account after sign-out without waiting for a route', async () => {
    const view = render(<EventReminderCoordinator />)
    await waitFor(() =>
      expect(coordinatorMocks.transition).toHaveBeenCalledWith('user_a'),
    )

    coordinatorMocks.auth.status = 'signed-out'
    coordinatorMocks.auth.user = null
    view.rerender(<EventReminderCoordinator />)

    await waitFor(() =>
      expect(coordinatorMocks.transition).toHaveBeenCalledWith(null),
    )
  })
})
