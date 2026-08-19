import { act, render, screen, waitFor } from '@testing-library/react'
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
vi.mock('../onboarding', () => ({
  useFamilyOnboarding: () => ({
    snapshot: {
      kind: 'member',
      membership: { familyId: 'family_test' },
    },
  }),
}))

import { JournalEventsSection } from './JournalEventsSection'
import {
  eventStorageKey,
  familyEventStorageSubject,
} from './eventStorage'

const storageSubject = familyEventStorageSubject('user_test', 'family_test')

function renderJournalEventsSection() {
  return render(
    <MemoryRouter>
      <JournalEventsSection />
    </MemoryRouter>,
  )
}

function storeCreatedPlans(
  plans: Array<{
    id: string
    title: string
    startsAt: string
    location: string
    category?: string
  }>,
) {
  localStorage.setItem(
    eventStorageKey('kinsphere-created-events', storageSubject),
    JSON.stringify(
      plans.map((plan) => {
        const startsAt = new Date(plan.startsAt)
        return {
          ...plan,
          date: [
            startsAt.getFullYear(),
            String(startsAt.getMonth() + 1).padStart(2, '0'),
            String(startsAt.getDate()).padStart(2, '0'),
          ].join('-'),
          time: `${String(startsAt.getHours()).padStart(2, '0')}:${String(
            startsAt.getMinutes(),
          ).padStart(2, '0')}`,
        }
      }),
    ),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
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

describe('JournalEventsSection', () => {
  it('shows an honest, actionable empty state without placeholder events', async () => {
    renderJournalEventsSection()

    expect(
      screen.getByRole('heading', { name: 'Important plans' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Milestones worth remembering')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Coming up' })).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'No important plans yet' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add your first plan' })).toBeInTheDocument()
    expect(screen.queryByText('Family dinner')).not.toBeInTheDocument()
    expect(screen.queryByText('Beach breakfast')).not.toBeInTheDocument()
  })

  it('keeps a compact three-plan list and expands accessibly', async () => {
    storeCreatedPlans([
      {
        id: 'flight-home',
        title: 'Flight home',
        startsAt: '2099-12-20T09:00:00',
        location: 'Dubai International Airport',
        category: 'travel',
      },
      {
        id: 'graduation',
        title: 'Sara’s graduation',
        startsAt: '2099-12-21T18:00:00',
        location: 'University campus',
        category: 'graduation',
      },
      {
        id: 'wedding',
        title: 'Amina’s wedding',
        startsAt: '2099-12-22T17:00:00',
        location: 'The ceremony hall',
        category: 'wedding',
      },
      {
        id: 'appointment',
        title: 'Grandad’s appointment',
        startsAt: '2099-12-23T11:00:00',
        location: 'City clinic',
        category: 'appointment',
      },
    ])
    const user = userEvent.setup()
    const { container } = renderJournalEventsSection()

    const expand = screen.getByRole('button', {
      name: 'Show all 4 upcoming family events',
    })
    const controlledListId = expand.getAttribute('aria-controls')

    expect(expand).toHaveAttribute('aria-expanded', 'false')
    expect(controlledListId).toBeTruthy()
    expect(document.getElementById(controlledListId ?? '')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Flight home' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sara’s graduation' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Amina’s wedding' })).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Grandad’s appointment' }),
    ).not.toBeInTheDocument()
    expect(container.querySelectorAll('.journal-events__upcoming-list article')).toHaveLength(3)

    await user.click(expand)

    const collapse = screen.getByRole('button', {
      name: 'Show fewer upcoming family plans',
    })
    expect(collapse).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByRole('heading', { name: 'Grandad’s appointment' }),
    ).toBeInTheDocument()
    expect(container.querySelectorAll('.journal-events__upcoming-list article')).toHaveLength(4)

    await user.click(collapse)

    expect(screen.getByRole('button', {
      name: 'Show all 4 upcoming family events',
    })).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelectorAll('.journal-events__upcoming-list article')).toHaveLength(3)
  })

  it('excludes legacy and remote events that were not classified as important', async () => {
    storeCreatedPlans([
      {
        id: 'legacy-dinner',
        title: 'Family dinner',
        startsAt: '2099-12-20T19:00:00',
        location: 'Home',
      },
    ])
    eventServiceMocks.fetchFamilyEvents.mockResolvedValue([
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
        title: 'Weekly catch-up',
        startsAt: '2099-12-21T18:00:00.000Z',
        location: 'Video call',
        details: null,
      },
    ])

    renderJournalEventsSection()

    expect(
      await screen.findByRole('heading', { name: 'No important plans yet' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Family dinner')).not.toBeInTheDocument()
    expect(screen.queryByText('Weekly catch-up')).not.toBeInTheDocument()
  })

  it('creates and saves a categorized important plan', async () => {
    const user = userEvent.setup()
    renderJournalEventsSection()

    await user.click(screen.getByRole('button', { name: 'Add plan' }))
    expect(
      screen.getByRole('dialog', { name: 'Add an important plan' }),
    ).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Plan type'), 'graduation')
    await user.type(screen.getByLabelText('Plan name'), 'Sara’s graduation')
    await user.type(screen.getByLabelText('Date'), '2099-12-20')
    await user.type(screen.getByLabelText('Time'), '16:30')
    await user.type(screen.getByLabelText('Location'), 'University campus')
    await user.click(screen.getByRole('button', { name: 'Save plan' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Sara’s graduation' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/University campus/)).toBeInTheDocument()
    expect(screen.getByText('Graduation')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Remind me about Sara’s graduation' }),
    ).toBeInTheDocument()
    expect(eventServiceMocks.createFamilyEvent).toHaveBeenCalledWith({
      title: 'Sara’s graduation',
      startsAt: '2099-12-20T16:30:00',
      location: 'University campus',
      details: 'kinsphere-plan-category:v1:graduation',
    })
    expect(
      localStorage.getItem(
        eventStorageKey('kinsphere-created-events', storageSubject),
      ),
    ).toContain('Sara’s graduation')
    expect(localStorage.getItem('kinsphere-created-events')).toBeNull()
  })

  it('keeps a local-only plan open for retry when device persistence fails', async () => {
    const user = userEvent.setup()
    renderJournalEventsSection()

    await user.click(screen.getByRole('button', { name: 'Add plan' }))
    await user.selectOptions(screen.getByLabelText('Plan type'), 'travel')
    await user.type(screen.getByLabelText('Plan name'), 'Flight home')
    await user.type(screen.getByLabelText('Date'), '2099-12-20')
    await user.type(screen.getByLabelText('Time'), '16:30')
    await user.type(screen.getByLabelText('Location'), 'Airport')

    const setItem = vi.spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('Storage unavailable', 'QuotaExceededError')
      })
    await user.click(screen.getByRole('button', { name: 'Save plan' }))

    expect(
      screen.getByRole('dialog', { name: 'Add an important plan' }),
    ).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This plan is not saved yet because device storage is unavailable. Keep this sheet open and try again.',
    )
    expect(screen.getByLabelText('Plan name')).toHaveValue('Flight home')
    expect(
      screen.queryByRole('heading', { name: 'Flight home' }),
    ).not.toBeInTheDocument()
    expect(
      localStorage.getItem(
        eventStorageKey('kinsphere-created-events', storageSubject),
      ),
    ).toBeNull()

    setItem.mockRestore()
    await user.click(screen.getByRole('button', { name: 'Save plan' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Flight home' }),
    ).toBeInTheDocument()
    expect(
      localStorage.getItem(
        eventStorageKey('kinsphere-created-events', storageSubject),
      ),
    ).toContain('Flight home')
  })

  it('keeps save errors inside the modal and restores focus when it closes', async () => {
    eventServiceMocks.createFamilyEvent.mockRejectedValueOnce(
      new Error('offline'),
    )
    const user = userEvent.setup()
    renderJournalEventsSection()
    const opener = screen.getByRole('button', { name: 'Add plan' })

    await user.click(opener)
    const planType = screen.getByLabelText('Plan type')
    await waitFor(() => expect(planType).toHaveFocus())
    screen.getByRole('button', { name: 'Close add plan' }).focus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.getByRole('button', { name: 'Save plan' })).toHaveFocus()

    await user.selectOptions(planType, 'travel')
    await user.type(screen.getByLabelText('Plan name'), 'Flight home')
    await user.type(screen.getByLabelText('Date'), '2099-12-20')
    await user.type(screen.getByLabelText('Time'), '16:30')
    await user.type(screen.getByLabelText('Location'), 'Airport')
    await user.click(screen.getByRole('button', { name: 'Save plan' }))

    const dialog = screen.getByRole('dialog', { name: 'Add an important plan' })
    expect(dialog).toContainElement(await screen.findByRole('alert'))
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be saved/i)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('requests notification permission only after an explicit reminder action', async () => {
    storeCreatedPlans([
      {
        id: 'flight-home',
        title: 'Flight home',
        startsAt: '2099-12-20T09:00:00',
        location: 'Dubai International Airport',
        category: 'travel',
      },
    ])
    const requestPermission = vi.fn().mockResolvedValue('denied')
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission,
    })
    const user = userEvent.setup()
    renderJournalEventsSection()

    expect(requestPermission).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remind me about Flight home' }))

    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'Remove reminder for Flight home' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(
      /allow notifications in browser settings/i,
    )
    expect(
      localStorage.getItem(
        eventStorageKey('kinsphere-event-reminders', storageSubject),
      ),
    ).toContain('flight-home')
    expect(localStorage.getItem('kinsphere-event-reminders')).toBeNull()
  })

  it('loads shared family events and refreshes them after a Realtime change', async () => {
    const sharedEvents = [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
        title: 'Family flight',
        startsAt: '2099-12-20T12:30:00.000Z',
        location: 'Dubai International Airport',
        details: 'kinsphere-plan-category:v1:travel',
      },
    ]
    let notifyChange: () => void = () => undefined
    eventServiceMocks.fetchFamilyEvents
      .mockResolvedValueOnce(sharedEvents)
      .mockResolvedValueOnce([
        ...sharedEvents,
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
          title: 'Grandma’s anniversary',
          startsAt: '2099-12-21T12:30:00.000Z',
          location: 'Family home',
          details: 'kinsphere-plan-category:v1:anniversary',
        },
      ])
    eventServiceMocks.subscribeToFamilyEvents.mockImplementation(
      async (onChange: () => void) => {
        notifyChange = onChange
        return () => undefined
      },
    )

    renderJournalEventsSection()
    expect(
      await screen.findByRole('heading', { name: 'Family flight' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Travel')).toBeInTheDocument()

    await act(async () => {
      notifyChange()
      await Promise.resolve()
    })

    expect(
      await screen.findByRole('heading', { name: 'Grandma’s anniversary' }),
    ).toBeInTheDocument()
    expect(eventServiceMocks.fetchFamilyEvents).toHaveBeenCalledTimes(2)
  })
})
