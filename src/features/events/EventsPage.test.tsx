import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

const eventServiceMocks = vi.hoisted(() => ({
  createFamilyEvent: vi.fn(),
  deleteFamilyEvent: vi.fn(),
  fetchFamilyEvents: vi.fn(),
  subscribeToFamilyEvents: vi.fn(),
  syncEventReminder: vi.fn(),
  updateFamilyEventDetails: vi.fn(),
}))
const authMocks = vi.hoisted(() => ({ isDevelopmentPreview: false }))

vi.mock('./eventService', () => eventServiceMocks)
vi.mock('../auth', () => ({
  useAuth: () => ({
    user: { id: 'user_test' },
    isDevelopmentPreview: authMocks.isDevelopmentPreview,
  }),
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
import { eventStorageKey, familyEventStorageSubject } from './eventStorage'
import { decodePlanDetails } from './planDetails'

const storageSubject = familyEventStorageSubject('user_test', 'family_test')

function renderJournalEventsSection() {
  return render(
    <MemoryRouter>
      <JournalEventsSection />
    </MemoryRouter>,
  )
}

function localDateValue(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function dateFromToday(days: number, hour = 18) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  date.setHours(hour, 30, 0, 0)
  return date
}

function formatDayButton(date: Date) {
  const weekday = new Intl.DateTimeFormat('en', { weekday: 'long' }).format(date)
  const monthDay = new Intl.DateTimeFormat('en', {
    month: 'long',
    day: 'numeric',
  }).format(date)
  return `${weekday}, ${monthDay}`
}

function storeCreatedPlans(
  plans: Array<{
    id: string
    title: string
    startsAt: Date
    location: string
    category?: string
  }>,
) {
  localStorage.setItem(
    eventStorageKey('kinsphere-created-events', storageSubject),
    JSON.stringify(
      plans.map((plan) => ({
        ...plan,
        startsAt: plan.startsAt.toISOString(),
        date: localDateValue(plan.startsAt),
        time: `${String(plan.startsAt.getHours()).padStart(2, '0')}:${String(
          plan.startsAt.getMinutes(),
        ).padStart(2, '0')}`,
      })),
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
  authMocks.isDevelopmentPreview = false
  eventServiceMocks.createFamilyEvent.mockResolvedValue({
    id: 'family-local-test',
    synced: false,
  })
  eventServiceMocks.deleteFamilyEvent.mockResolvedValue(false)
  eventServiceMocks.fetchFamilyEvents.mockResolvedValue([])
  eventServiceMocks.subscribeToFamilyEvents.mockResolvedValue(() => undefined)
  eventServiceMocks.syncEventReminder.mockResolvedValue(false)
  eventServiceMocks.updateFamilyEventDetails.mockResolvedValue(false)
})

describe('JournalEventsSection', () => {
  it('shows the selected date in an actionable empty calendar state', async () => {
    renderJournalEventsSection()

    expect(screen.getByRole('heading', { name: 'Important plans' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Coming up' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: /^No plans on / })).toBeInTheDocument()
    expect(screen.getByText(/shared family calendar/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add plan' })).toBeInTheDocument()
  })

  it('filters the three demo plans onto distinct days in the current week', async () => {
    authMocks.isDevelopmentPreview = true
    const user = userEvent.setup()
    renderJournalEventsSection()

    expect(await screen.findByRole('heading', { name: 'Sunday dinner' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Maya’s birthday' })).not.toBeInTheDocument()

    const weekDays = document.querySelector('.journal-events__week-days')
    expect(weekDays).not.toBeNull()
    const plannedDays = within(weekDays as HTMLElement)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('data-has-plans') === 'true')
    expect(plannedDays).toHaveLength(3)

    await user.click(plannedDays[1])
    expect(screen.getByRole('heading', { name: 'Maya’s birthday' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sunday dinner' })).not.toBeInTheDocument()

    await user.click(plannedDays[2])
    expect(screen.getByRole('heading', { name: 'Family beach day' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Maya’s birthday' })).not.toBeInTheDocument()

    const emptyDay = within(weekDays as HTMLElement)
      .getAllByRole('button')
      .find((button) => button.getAttribute('data-has-plans') === 'false')
    expect(emptyDay).toBeTruthy()
    await user.click(emptyDay!)
    expect(screen.getByRole('heading', { name: /^No plans on / })).toBeInTheDocument()
  })

  it('strikes completed checklist text and restores it after reload', async () => {
    authMocks.isDevelopmentPreview = true
    const user = userEvent.setup()
    const view = renderJournalEventsSection()

    const flowers = await screen.findByRole('checkbox', { name: 'Bring flowers for Mum' })
    const label = flowers.closest('label')
    expect(label).toHaveAttribute('data-checked', 'false')
    await user.click(flowers)
    expect(flowers).toBeChecked()
    expect(label).toHaveAttribute('data-checked', 'true')
    expect(
      localStorage.getItem(
        eventStorageKey('kinsphere-plan-checklists:v1', storageSubject),
      ),
    ).toContain('bring-flowers')

    view.unmount()
    renderJournalEventsSection()
    expect(
      await screen.findByRole('checkbox', { name: 'Bring flowers for Mum' }),
    ).toBeChecked()
  })

  it('completes a demo plan and does not resurrect it after reload', async () => {
    authMocks.isDevelopmentPreview = true
    const user = userEvent.setup()
    const view = renderJournalEventsSection()

    expect(await screen.findByRole('heading', { name: 'Sunday dinner' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Complete task: Sunday dinner' }))
    expect(screen.queryByRole('heading', { name: 'Sunday dinner' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^No plans on / })).toBeInTheDocument()
    expect(
      localStorage.getItem(
        eventStorageKey('kinsphere-completed-plans:v1', storageSubject),
      ),
    ).toContain('demo-plan-sunday-dinner')

    view.unmount()
    renderJournalEventsSection()
    expect(screen.queryByRole('heading', { name: 'Sunday dinner' })).not.toBeInTheDocument()
  })

  it('creates a plan without a type dropdown and selects its calendar date', async () => {
    const user = userEvent.setup()
    const plannedDate = dateFromToday(1, 16)
    renderJournalEventsSection()

    await user.click(screen.getByRole('button', { name: 'Add plan' }))
    expect(screen.queryByLabelText('Plan type')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Plan name'), 'Family road trip')
    await user.type(screen.getByLabelText('Date'), localDateValue(plannedDate))
    await user.type(screen.getByLabelText('Time'), '16:30')
    await user.type(screen.getByLabelText('Location'), 'Mountain cabin')
    await user.type(screen.getByLabelText('First task'), 'Pack snacks')
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    await user.type(screen.getByLabelText('Task 2'), 'Charge the camera')
    await user.click(screen.getByRole('button', { name: 'Save plan' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Family road trip' })).toBeInTheDocument()
    expect(eventServiceMocks.createFamilyEvent).toHaveBeenCalledWith({
      title: 'Family road trip',
      startsAt: `${localDateValue(plannedDate)}T16:30:00`,
      location: 'Mountain cabin',
      details: expect.stringMatching(/^kinsphere-plan:v2:/),
    })
    const details = eventServiceMocks.createFamilyEvent.mock.calls[0]?.[0]?.details
    expect(decodePlanDetails(details)).toMatchObject({
      category: 'other',
      tasks: [{ label: 'Pack snacks' }, { label: 'Charge the camera' }],
    })
    expect(screen.getByRole('checkbox', { name: 'Pack snacks' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Charge the camera' })).toBeInTheDocument()
  })

  it('adds a checklist task from the plan card and restores it after reload', async () => {
    const user = userEvent.setup()
    const today = dateFromToday(0, 20)
    storeCreatedPlans([{
      id: 'dinner', title: 'Dinner', startsAt: today, location: 'Home', category: 'other',
    }])
    const view = renderJournalEventsSection()

    await user.click(screen.getByRole('button', { name: 'Add task' }))
    const composer = screen.getByRole('form', { name: 'Add task to Dinner' })
    await user.type(within(composer).getByLabelText('New task'), 'Bring flowers')
    await user.click(within(composer).getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('checkbox', { name: 'Bring flowers' })).toBeInTheDocument()

    view.unmount()
    renderJournalEventsSection()
    const restoredTask = await screen.findByRole('checkbox', { name: 'Bring flowers' })
    expect(restoredTask).not.toBeChecked()
    await user.click(restoredTask)
    expect(restoredTask.closest('label')).toHaveAttribute('data-checked', 'true')
  })

  it('shares a newly added task for a server-backed plan', async () => {
    const user = userEvent.setup()
    const today = dateFromToday(0, 20)
    const eventId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee9'
    eventServiceMocks.fetchFamilyEvents.mockResolvedValue([{
      id: eventId,
      title: 'Family supper',
      startsAt: today.toISOString(),
      location: 'Home',
      details: 'kinsphere-plan-category:v1:other',
    }])
    eventServiceMocks.updateFamilyEventDetails.mockResolvedValue(true)
    renderJournalEventsSection()

    expect(await screen.findByRole('heading', { name: 'Family supper' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    await user.type(screen.getByLabelText('New task'), 'Choose dessert')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(eventServiceMocks.updateFamilyEventDetails).toHaveBeenCalledWith(
      eventId,
      expect.stringMatching(/^kinsphere-plan:v2:/),
    )
    expect(screen.getByRole('checkbox', { name: 'Choose dessert' })).toBeInTheDocument()
  })

  it('uses notebook doodles instead of plan photographs', async () => {
    authMocks.isDevelopmentPreview = true
    renderJournalEventsSection()

    expect(await screen.findByRole('heading', { name: 'Sunday dinner' })).toBeInTheDocument()
    const card = screen.getByRole('heading', { name: 'Sunday dinner' }).closest('article')
    expect(card?.querySelector('.event-plan-card__sketch')).not.toBeNull()
    expect(card?.querySelector('img')).toBeNull()
  })

  it('completes a shared plan through the shared completion service', async () => {
    const user = userEvent.setup()
    const today = dateFromToday(0, 20)
    const eventId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'
    eventServiceMocks.fetchFamilyEvents.mockResolvedValue([{
      id: eventId,
      title: 'Family supper',
      startsAt: today.toISOString(),
      location: 'Home',
      details: 'kinsphere-plan-category:v1:other',
    }])
    eventServiceMocks.deleteFamilyEvent.mockResolvedValue(true)
    renderJournalEventsSection()

    expect(await screen.findByRole('heading', { name: 'Family supper' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Complete task: Family supper' }))
    expect(screen.queryByRole('heading', { name: 'Family supper' })).not.toBeInTheDocument()
    expect(eventServiceMocks.deleteFamilyEvent).toHaveBeenCalledWith(eventId)
    expect(await screen.findByRole('status')).toHaveTextContent(/shared calendar/i)
  })

  it('changes weeks and filters locally saved plans by the selected date', async () => {
    const user = userEvent.setup()
    const today = dateFromToday(0, 20)
    const tomorrow = dateFromToday(1, 20)
    const nextWeek = dateFromToday(7, 20)
    storeCreatedPlans([
      { id: 'today', title: 'Today plan', startsAt: today, location: 'Home', category: 'other' },
      { id: 'tomorrow', title: 'Tomorrow plan', startsAt: tomorrow, location: 'Park', category: 'other' },
      { id: 'next-week', title: 'Next week plan', startsAt: nextWeek, location: 'Beach', category: 'other' },
    ])
    renderJournalEventsSection()

    expect(screen.getByRole('heading', { name: 'Today plan' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Tomorrow plan' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: new RegExp(`^${formatDayButton(tomorrow)}`) }))
    expect(screen.getByRole('heading', { name: 'Tomorrow plan' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Today plan' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Next week' }))
    expect(screen.getByRole('heading', { name: /^No plans on / })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: new RegExp(`^${formatDayButton(nextWeek)}`) }))
    expect(screen.getByRole('heading', { name: 'Next week plan' })).toBeInTheDocument()
  })

  it('toggles a device reminder only after an explicit action', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(dateFromToday(0, 12).getTime())
    const today = dateFromToday(0, 20)
    storeCreatedPlans([{
      id: 'dinner', title: 'Dinner', startsAt: today, location: 'Home', category: 'other',
    }])
    const requestPermission = vi.fn().mockResolvedValue('denied')
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    const user = userEvent.setup()
    renderJournalEventsSection()

    expect(requestPermission).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remind me about Dinner' }))
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Remove reminder for Dinner' }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps local-only creation in the sheet when persistence fails', async () => {
    const user = userEvent.setup()
    const plannedDate = dateFromToday(1)
    renderJournalEventsSection()
    await user.click(screen.getByRole('button', { name: 'Add plan' }))
    await user.type(screen.getByLabelText('Plan name'), 'Flight home')
    await user.type(screen.getByLabelText('Date'), localDateValue(plannedDate))
    await user.type(screen.getByLabelText('Time'), '16:30')
    await user.type(screen.getByLabelText('Location'), 'Airport')

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'QuotaExceededError')
    })
    await user.click(screen.getByRole('button', { name: 'Save plan' }))
    expect(screen.getByRole('dialog', { name: 'Add an important plan' })).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(/not saved yet/i)

    setItem.mockRestore()
    await user.click(screen.getByRole('button', { name: 'Save plan' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Flight home' })).toBeInTheDocument()
  })

  it('refreshes shared plans after a Realtime family-calendar change', async () => {
    const today = dateFromToday(0, 20)
    let notifyChange: () => void = () => undefined
    const first = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
      title: 'Family flight',
      startsAt: today.toISOString(),
      location: 'Airport',
      details: 'kinsphere-plan-category:v1:other',
    }
    eventServiceMocks.fetchFamilyEvents
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([
        first,
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
          title: 'Family picnic',
          startsAt: new Date(today.getTime() + 30 * 60 * 1000).toISOString(),
          location: 'Park',
          details: 'kinsphere-plan-category:v1:other',
        },
      ])
    eventServiceMocks.subscribeToFamilyEvents.mockImplementation(
      async (onChange: () => void) => {
        notifyChange = onChange
        return () => undefined
      },
    )
    renderJournalEventsSection()
    expect(await screen.findByRole('heading', { name: 'Family flight' })).toBeInTheDocument()

    await act(async () => {
      notifyChange()
      await Promise.resolve()
    })
    expect(await screen.findByRole('heading', { name: 'Family picnic' })).toBeInTheDocument()
  })

  it('traps focus in the add-plan sheet and restores it after Escape', async () => {
    const user = userEvent.setup()
    renderJournalEventsSection()
    const opener = screen.getByRole('button', { name: 'Add plan' })
    await user.click(opener)
    const name = screen.getByLabelText('Plan name')
    await waitFor(() => expect(name).toHaveFocus())
    screen.getByRole('button', { name: 'Close add plan' }).focus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.getByRole('button', { name: 'Save plan' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())
  })
})
