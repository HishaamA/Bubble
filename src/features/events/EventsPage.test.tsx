import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

const eventServiceMocks = vi.hoisted(() => ({
  createFamilyEvent: vi.fn(),
  fetchFamilyEvents: vi.fn(),
  subscribeToFamilyEvents: vi.fn(),
  syncEventReminder: vi.fn(),
}))

vi.mock('./eventService', () => eventServiceMocks)
vi.mock('../auth', () => ({
  useAuth: () => ({ user: { id: 'user_test' } }),
}))

import { EventsPage, eventStorageKey } from './EventsPage'

function renderEventsPage() {
  return render(
    <MemoryRouter>
      <EventsPage />
    </MemoryRouter>,
  )
}

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.clearAllMocks()
  eventServiceMocks.createFamilyEvent.mockResolvedValue({
    id: 'family-local-test',
    synced: false,
  })
  eventServiceMocks.fetchFamilyEvents.mockResolvedValue([])
  eventServiceMocks.subscribeToFamilyEvents.mockResolvedValue(() => undefined)
  eventServiceMocks.syncEventReminder.mockResolvedValue(false)
})

describe('EventsPage', () => {
  it('updates RSVP and guestbook state locally', async () => {
    const user = userEvent.setup()
    renderEventsPage()

    const rsvp = screen.getByRole('button', { name: 'I’m going' })
    await user.click(rsvp)
    expect(screen.getByRole('button', { name: '✓ Going' })).toHaveAttribute('aria-pressed', 'true')

    await user.type(screen.getByRole('textbox', { name: /add a note/i }), 'Save me a seat!')
    await user.click(screen.getByRole('button', { name: 'Add guestbook note' }))

    expect(screen.getByText('Save me a seat!')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Dinner notes' })).toBeInTheDocument()
    expect(screen.queryByText(/prototype/i)).not.toBeInTheDocument()
  })

  it('brings family plans and capsules together', () => {
    renderEventsPage()

    expect(screen.getByRole('heading', { name: 'Together' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Saved for later' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Letters from this summer' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'For your first home' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Grandad’s recipe box' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See all capsules' })).toHaveAttribute('href', '/capsules')
  })

  it('creates and saves a family event from the add event sheet', async () => {
    const user = userEvent.setup()
    renderEventsPage()

    await user.click(screen.getByRole('button', { name: 'Add event' }))
    expect(screen.getByRole('dialog', { name: 'Add a family event' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('What’s happening?'), 'Cousins picnic')
    await user.type(screen.getByLabelText('Date'), '2099-12-20')
    await user.type(screen.getByLabelText('Time'), '16:30')
    await user.type(screen.getByLabelText('Where?'), 'Creek Park')
    await user.click(screen.getByRole('button', { name: 'Add to Together' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Cousins picnic' })).toBeInTheDocument()
    expect(screen.getByText(/Creek Park/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Remind me about Cousins picnic' }),
    ).toBeInTheDocument()
    expect(
      localStorage.getItem(
        eventStorageKey('kinsphere-created-events', 'user_test'),
      ),
    ).toContain('Cousins picnic')
    expect(localStorage.getItem('kinsphere-created-events')).toBeNull()
  })

  it('requests notification permission only after an explicit reminder action', async () => {
    const requestPermission = vi.fn().mockResolvedValue('denied')
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission,
    })
    const user = userEvent.setup()
    renderEventsPage()

    expect(requestPermission).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remind me about Beach breakfast' }))

    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'Remove reminder for Beach breakfast' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(/allow notifications in browser settings/i)
    expect(
      localStorage.getItem(
        eventStorageKey('kinsphere-event-reminders', 'user_test'),
      ),
    ).toContain('beach-breakfast')
    expect(localStorage.getItem('kinsphere-event-reminders')).toBeNull()
  })

  it('loads shared family events and refreshes them after a Realtime change', async () => {
    const sharedEvents = [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
        title: 'Family hike',
        startsAt: '2099-12-20T12:30:00.000Z',
        location: 'Hatta',
        details: null,
      },
    ]
    let notifyChange: () => void = () => undefined
    eventServiceMocks.fetchFamilyEvents
      .mockResolvedValueOnce(sharedEvents)
      .mockResolvedValueOnce([
        ...sharedEvents,
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
          title: 'Grandma’s tea',
          startsAt: '2099-12-21T12:30:00.000Z',
          location: 'Family home',
          details: null,
        },
      ])
    eventServiceMocks.subscribeToFamilyEvents.mockImplementation(
      async (onChange: () => void) => {
        notifyChange = onChange
        return () => undefined
      },
    )

    renderEventsPage()
    expect(
      await screen.findByRole('heading', { name: 'Family hike' }),
    ).toBeInTheDocument()

    await act(async () => {
      notifyChange()
      await Promise.resolve()
    })

    expect(
      await screen.findByRole('heading', { name: 'Grandma’s tea' }),
    ).toBeInTheDocument()
    expect(eventServiceMocks.fetchFamilyEvents).toHaveBeenCalledTimes(2)
  })
})
