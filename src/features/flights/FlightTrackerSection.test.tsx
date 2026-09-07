import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightNotificationResult } from './flightNotifications'
import type { CreateTrackedFamilyFlightResult, FlightLookupChoice } from './flightStatusService'
import type { FlightStatusSnapshot } from './types'

const serviceMocks = vi.hoisted(() => {
  class FlightStatusError extends Error {
    readonly code: string

    constructor(message: string, code: string) {
      super(message)
      this.code = code
    }
  }
  return {
    FlightStatusError,
    createTrackedFamilyFlight: vi.fn(),
    createTrackedFlightId: vi.fn(() => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    fetchFamilyFlights: vi.fn(),
    refreshTrackedFamilyFlight: vi.fn(),
    removeFamilyFlight: vi.fn(),
    subscribeToFamilyFlights: vi.fn(),
  }
})

const notificationMocks = vi.hoisted(() => ({
  cancelFlightNotifications: vi.fn(),
  enableFlightNotifications: vi.fn(),
  rescheduleFlightNotifications: vi.fn(),
}))

const identityMocks = vi.hoisted(() => ({
  userId: 'user_test',
  familyId: 'family_test',
  isDevelopmentPreview: false,
}))

vi.mock('../auth', () => ({
  useAuth: () => ({
    user: {
      id: identityMocks.userId,
      displayName: 'Hishaam Ali',
      email: null,
      phone: null,
      imageUrl: null,
    },
    isDevelopmentPreview: identityMocks.isDevelopmentPreview,
  }),
}))
vi.mock('../onboarding', () => ({
  useFamilyOnboarding: () => ({
    snapshot: {
      kind: 'member',
      membership: { familyId: identityMocks.familyId },
    },
  }),
}))
vi.mock('./flightStatusService', () => serviceMocks)
vi.mock('./flightNotifications', () => notificationMocks)
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}))

import { FlightTrackerSection } from './FlightTrackerSection'
import {
  familyFlightStorageSubject,
  flightStorageKey,
  writeActiveFlightStorageSubject,
  writeTrackedFlights,
} from './flightStorage'

const testFlightSubject = () => familyFlightStorageSubject(
  identityMocks.userId,
  identityMocks.familyId,
)

const status: FlightStatusSnapshot = {
  provider: 'aerodatabox',
  providerFlightId: '2026-09-10:EK202',
  flightNumber: 'EK202',
  status: 'On time',
  dataQuality: 'estimated',
  origin: {
    code: 'JFK',
    name: 'John F. Kennedy International',
    city: 'New York',
    latitude: 40.6413,
    longitude: -73.7781,
    timeZone: 'America/New_York',
  },
  destination: {
    code: 'DXB',
    name: 'Dubai International',
    city: 'Dubai',
    latitude: 25.2532,
    longitude: 55.3657,
    timeZone: 'Asia/Dubai',
  },
  scheduledDeparture: '2026-09-10T10:00:00.000Z',
  estimatedDeparture: null,
  actualDeparture: null,
  scheduledArrival: '2026-09-10T20:00:00.000Z',
  estimatedArrival: '2026-09-10T20:15:00.000Z',
  actualArrival: null,
  progressPercent: 0,
  position: null,
  updatedAt: '2026-08-29T12:00:00.000Z',
}

const createdResult = (
  snapshot: FlightStatusSnapshot = status,
): CreateTrackedFamilyFlightResult => ({ kind: 'created', snapshot })

const lookupChoices: FlightLookupChoice[] = [
  {
    providerFlightId: 'EK202:2026-09-10T10:00:00Z',
    flightNumber: 'EK202',
    operatingFlightNumber: null,
    origin: {
      code: 'JFK',
      name: 'John F. Kennedy International',
      city: 'New York',
      timeZone: 'America/New_York',
    },
    destination: {
      code: 'DXB',
      name: 'Dubai International',
      city: 'Dubai',
      timeZone: 'Asia/Dubai',
    },
    scheduledDeparture: '2026-09-10T10:00:00.000Z',
    scheduledArrival: '2026-09-10T20:00:00.000Z',
  },
  {
    providerFlightId: 'EK202:2026-09-10T18:00:00Z',
    flightNumber: 'EK202',
    operatingFlightNumber: 'EK4202',
    origin: {
      code: 'LAX',
      name: 'Los Angeles International',
      city: 'Los Angeles',
      timeZone: 'America/Los_Angeles',
    },
    destination: {
      code: 'DXB',
      name: 'Dubai International',
      city: 'Dubai',
      timeZone: 'Asia/Dubai',
    },
    scheduledDeparture: '2026-09-10T18:00:00.000Z',
    scheduledArrival: '2026-09-11T10:00:00.000Z',
  },
]

async function addFlight() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Track a flight' }))
  await user.type(screen.getByLabelText(/Header/), 'Sara')
  await user.type(screen.getByLabelText('Flight number'), 'ek 202')
  await user.type(screen.getByLabelText('Departure date'), '2026-09-10')
  await user.click(screen.getByRole('button', { name: 'Track flight' }))
  return user
}

async function expandFlightInfo(
  user: ReturnType<typeof userEvent.setup>,
  flightNumber: string,
) {
  await user.click(await screen.findByRole('button', {
    name: `Show all info for ${flightNumber}`,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  identityMocks.userId = 'user_test'
  identityMocks.familyId = 'family_test'
  identityMocks.isDevelopmentPreview = false
  serviceMocks.fetchFamilyFlights.mockResolvedValue([])
  serviceMocks.createTrackedFamilyFlight.mockResolvedValue(createdResult())
  serviceMocks.refreshTrackedFamilyFlight.mockResolvedValue(status)
  serviceMocks.removeFamilyFlight.mockResolvedValue(true)
  serviceMocks.subscribeToFamilyFlights.mockResolvedValue(() => undefined)
  notificationMocks.cancelFlightNotifications.mockResolvedValue(undefined)
  notificationMocks.enableFlightNotifications.mockResolvedValue({
    enabled: true,
    mode: 'native',
    message: 'Departure and arrival alerts set on this phone.',
  })
  notificationMocks.rescheduleFlightNotifications.mockResolvedValue(true)
})

afterEach(() => localStorage.clear())

describe('FlightTrackerSection', () => {
  it('starts with a real empty state and no example flight cards', () => {
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    expect(screen.getByRole('heading', { name: 'Family flights' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No journeys on the board yet' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Track a flight' })).toBeInTheDocument()
    expect(screen.getByText('When travel is booked, add the flight so everyone can follow along.'))
      .toBeInTheDocument()
    expect(screen.queryByText('EK202')).not.toBeInTheDocument()
  })

  it('joins the header dotted route to the paper plane at one exact point', () => {
    const { container } = render(
      <FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />,
    )
    const route = container.querySelector('.flight-doodle-header__route')
    const join = container.querySelector('.flight-doodle-header__route-join')
    const plane = container.querySelector('.flight-doodle-header__plane')

    expect(route?.getAttribute('d')).toMatch(/160 38$/)
    expect(join).toHaveAttribute('cx', '160')
    expect(join).toHaveAttribute('cy', '38')
    expect(plane?.getAttribute('d')).toMatch(/^M160 38\b/)
  })

  it('shows local sample flights only in demo mode and completes one from its card', async () => {
    identityMocks.isDevelopmentPreview = true
    const { unmount } = render(
      <FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />,
    )
    const user = userEvent.setup()

    expect(screen.getByText('EK001')).toBeInTheDocument()
    expect(screen.getByText('SV301')).toBeInTheDocument()
    expect(screen.queryByText('Boarding pass')).not.toBeInTheDocument()
    expect(screen.queryByText('Passenger')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No journeys on the board yet' })).not.toBeInTheDocument()

    await expandFlightInfo(user, 'EK001')
    expect(screen.queryByRole('dialog', { name: 'EK001' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Turn on alerts for EK001' }))
    expect(screen.getByRole('button', { name: 'Turn off alerts for EK001' }))
      .toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Turn off alerts for EK001' }))
    expect(screen.getByRole('button', { name: 'Turn on alerts for EK001' }))
      .toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: 'Stop tracking EK001' }))
    await user.click(screen.getByRole('button', { name: 'Keep flight' }))
    expect(screen.queryByRole('dialog', { name: 'EK001' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop tracking EK001' }))
      .toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stop tracking EK001' }))
    await user.click(screen.getByRole('button', { name: 'Yes, stop tracking' }))

    await waitFor(() => expect(screen.queryByText('EK001')).not.toBeInTheDocument())
    expect(screen.getByText('SV301')).toBeInTheDocument()
    expect(serviceMocks.removeFamilyFlight).not.toHaveBeenCalled()

    unmount()
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    expect(screen.queryByText('EK001')).not.toBeInTheDocument()
    expect(screen.getByText('SV301')).toBeInTheDocument()
  })

  it('renders every flight as a full ticket and expands later flights in place', async () => {
    identityMocks.isDevelopmentPreview = true
    const { container } = render(
      <FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />,
    )
    const user = userEvent.setup()

    expect(screen.getByText('7h 35m · Direct')).toBeInTheDocument()
    expect(screen.getByText('3h 10m · Direct')).toBeInTheDocument()
    expect(container.querySelectorAll('.flight-list__featured')).toHaveLength(2)
    expect(container.querySelectorAll('.flight-card--featured')).toHaveLength(2)
    expect(container.querySelector('.flight-list__compact')).not.toBeInTheDocument()
    expect(container.querySelector('.flight-card--compact')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.flight-card__route')).toHaveLength(2)
    expect(container.querySelectorAll('.flight-progress')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Show all info for SV301' }))
    expect(screen.getByRole('region', { name: 'SV301 full flight information' }))
      .toBeInTheDocument()
    expect(screen.getByRole('img', { name: /SV301 route from JED to CAI/i }))
      .toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'SV301' })).not.toBeInTheDocument()
    expect(window.location.hash).not.toContain('flight')
    await user.click(screen.getByRole('button', { name: 'Hide all info for SV301' }))
    await user.click(screen.getByRole('button', { name: 'Add flight' }))
    expect(screen.getByRole('dialog', { name: 'Track a flight' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close add flight' }))
    expect(screen.queryByRole('dialog', { name: 'Track a flight' })).not.toBeInTheDocument()
  })

  it('uses an in-card arrow plus icon-only controls without profile or tag decoration', async () => {
    identityMocks.isDevelopmentPreview = true
    const { container } = render(
      <FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />,
    )
    const user = userEvent.setup()
    const actions = screen.getByRole('button', {
      name: 'Show all info for EK001',
    })

    expect(actions).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Track flight')).not.toBeInTheDocument()
    expect(screen.queryByText(/adventure together/i)).not.toBeInTheDocument()
    expect(container.querySelector('.flight-family')).not.toBeInTheDocument()

    await user.click(actions)
    expect(screen.getByRole('button', {
      name: 'Hide all info for EK001',
    })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Refresh EK001' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop tracking EK001' })).toBeInTheDocument()
    expect(screen.queryByText(/^Alerts$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Refresh$/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Turn on alerts for EK001' }))

    expect(notificationMocks.enableFlightNotifications).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Turn off alerts for EK001' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(/alerts set on this phone/i)
  })

  it('recovers cleanly when an alert permission action fails', async () => {
    notificationMocks.enableFlightNotifications.mockRejectedValueOnce(
      new Error('notification bridge unavailable'),
    )
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    await user.click(screen.getByRole('button', { name: 'Turn on alerts for EK202' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/could not be changed/i)
    expect(screen.getByRole('button', { name: 'Turn on alerts for EK202' })).toBeEnabled()
  })

  it('explains why a ticket number cannot be used and never stores it', async () => {
    const user = userEvent.setup()
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    await user.click(screen.getByRole('button', { name: 'Track a flight' }))
    expect(screen.getByText(/codeshares are matched automatically/i)).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Header/), 'Sara')
    await user.type(screen.getByLabelText('Flight number'), '1761234567890')
    await user.type(screen.getByLabelText('Departure date'), '2026-09-10')
    await user.click(screen.getByRole('button', { name: 'Track flight' }))

    expect(screen.getByRole('alert')).toHaveTextContent(/public flight trackers/i)
    expect(screen.getByRole('alert')).toHaveTextContent(/never stored/i)
    expect(serviceMocks.createTrackedFamilyFlight).not.toHaveBeenCalled()
    expect(localStorage.getItem(flightStorageKey(testFlightSubject()))).toBe('[]')
    expect(localStorage.getItem(flightStorageKey(testFlightSubject()))).not.toContain('1761234567890')
  })

  it('stores a unique created result without asking the user to choose', async () => {
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    await addFlight()

    expect(serviceMocks.createTrackedFamilyFlight).toHaveBeenCalledWith(
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        travelerName: 'Sara',
        flightNumber: 'EK202',
        travelDate: '2026-09-10',
        clientCalendarDate: '2026-08-29',
      },
      { signal: expect.any(AbortSignal) },
    )
    expect(await screen.findByText('JFK')).toBeInTheDocument()
    expect(screen.getByText('DXB')).toBeInTheDocument()
    expect(screen.getByText('Estimated')).toBeInTheDocument()
    expect(screen.queryByText(/flights that day/i)).not.toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'EK202 journey progress' })).toHaveAttribute('aria-valuenow', '0')
    expect(localStorage.getItem(flightStorageKey(testFlightSubject()))).toContain('EK202')
  })

  it('asks the user to choose only when the lookup returns multiple departures', async () => {
    let resolveSelection!: (value: CreateTrackedFamilyFlightResult) => void
    const selectedSnapshot: FlightStatusSnapshot = {
      ...status,
      providerFlightId: lookupChoices[1].providerFlightId,
      operatingFlightNumber: lookupChoices[1].operatingFlightNumber,
      origin: {
        ...status.origin,
        code: 'LAX',
        name: 'Los Angeles International',
        city: 'Los Angeles',
        latitude: 33.9416,
        longitude: -118.4085,
        timeZone: 'America/Los_Angeles',
      },
      scheduledDeparture: lookupChoices[1].scheduledDeparture,
      scheduledArrival: lookupChoices[1].scheduledArrival,
    }
    serviceMocks.createTrackedFamilyFlight
      .mockResolvedValueOnce({ kind: 'choices', choices: lookupChoices })
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveSelection = resolve
      }))

    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()

    expect(await screen.findByRole('heading', {
      name: 'We found 2 flights that day',
    })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Choose .* to DXB, departing/ }))
      .toHaveLength(2)
    await user.click(screen.getByRole('button', {
      name: /Choose LAX to DXB, departing/,
    }))

    await waitFor(() => expect(serviceMocks.createTrackedFamilyFlight).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Change search' })).toBeDisabled()
    for (const choice of screen.getAllByRole('button', {
      name: /Choose .* to DXB, departing/,
    })) expect(choice).toBeDisabled()
    expect(serviceMocks.createTrackedFamilyFlight.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        flightNumber: 'EK202',
        travelDate: '2026-09-10',
        providerFlightId: lookupChoices[1].providerFlightId,
      }),
    )
    await act(async () => resolveSelection(createdResult(selectedSnapshot)))
    expect(await screen.findByText('LAX')).toBeInTheDocument()
    expect(screen.queryByText(/flights that day/i)).not.toBeInTheDocument()
  })

  it('lets an ambiguous lookup return to its original editable search', async () => {
    serviceMocks.createTrackedFamilyFlight.mockResolvedValueOnce({
      kind: 'choices',
      choices: lookupChoices,
    })
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    const changeSearch = await screen.findByRole('button', { name: 'Change search' })

    expect(screen.getByLabelText('Flight number')).toBeDisabled()
    expect(screen.getByLabelText('Departure date')).toBeDisabled()
    await user.click(changeSearch)

    expect(screen.queryByRole('heading', {
      name: 'We found 2 flights that day',
    })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Flight number')).toBeEnabled()
    expect(screen.getByLabelText('Flight number')).toHaveValue('ek 202')
    expect(screen.getByLabelText('Departure date')).toBeEnabled()
    expect(screen.getByLabelText('Departure date')).toHaveValue('2026-09-10')
  })

  it('uses a friendly card label when the optional header is blank', async () => {
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Track a flight' }))
    expect(screen.getByLabelText(/Header/)).not.toBeRequired()
    await user.type(screen.getByLabelText('Flight number'), 'EK202')
    await user.type(screen.getByLabelText('Departure date'), '2026-09-10')
    await user.click(screen.getByRole('button', { name: 'Track flight' }))

    expect(serviceMocks.createTrackedFamilyFlight).toHaveBeenCalledWith(
      expect.objectContaining({ travelerName: 'Family flight' }),
      { signal: expect.any(AbortSignal) },
    )
    expect(await screen.findByText('Family flight')).toBeInTheDocument()
  })

  it('shows backend setup failures as form errors without marking the flight number invalid', async () => {
    serviceMocks.createTrackedFamilyFlight.mockRejectedValueOnce(
      new serviceMocks.FlightStatusError(
        'Live flight tracking is not configured.',
        'not-configured',
      ),
    )
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    await addFlight()

    expect(await screen.findByRole('alert')).toHaveTextContent(/not configured/i)
    expect(screen.getByLabelText('Flight number')).not.toHaveAttribute('aria-invalid', 'true')
  })

  it('lets the add sheet close during a request and ignores its late result', async () => {
    let resolveCreate!: (value: CreateTrackedFamilyFlightResult) => void
    serviceMocks.createTrackedFamilyFlight.mockReturnValueOnce(new Promise((resolve) => {
      resolveCreate = resolve
    }))
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()

    const close = screen.getByRole('button', { name: 'Close add flight' })
    expect(close).toBeEnabled()
    await user.click(close)
    expect(screen.queryByRole('dialog', { name: 'Track a flight' })).not.toBeInTheDocument()
    await act(async () => resolveCreate(createdResult()))
    expect(screen.queryByText('JFK')).not.toBeInTheDocument()
    expect(serviceMocks.createTrackedFamilyFlight.mock.calls[0][1].signal.aborted)
      .toBe(true)
  })

  it('closes the add sheet with Escape and restores focus to its opener', async () => {
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = userEvent.setup()
    const opener = screen.getByRole('button', { name: 'Track a flight' })

    await user.click(opener)
    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Close add flight',
    })).toHaveFocus())
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Track a flight' }))
      .not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('latches same-tick add submissions and locks their captured fields', async () => {
    let resolveCreate!: (value: CreateTrackedFamilyFlightResult) => void
    serviceMocks.createTrackedFamilyFlight.mockReturnValueOnce(new Promise((resolve) => {
      resolveCreate = resolve
    }))
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Track a flight' }))
    await user.type(screen.getByLabelText(/Header/), 'Sara')
    await user.type(screen.getByLabelText('Flight number'), 'EK202')
    await user.type(screen.getByLabelText('Departure date'), '2026-09-10')
    const submit = screen.getByRole('button', { name: 'Track flight' })

    act(() => {
      submit.click()
      submit.click()
    })

    expect(serviceMocks.createTrackedFamilyFlight).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText(/Header/)).toBeDisabled()
    expect(screen.getByLabelText('Flight number')).toBeDisabled()
    expect(screen.getByLabelText('Departure date')).toBeDisabled()
    await act(async () => resolveCreate(createdResult()))
    expect(await screen.findByText('JFK')).toBeInTheDocument()
  })

  it('reuses one create ID after an uncertain failure', async () => {
    serviceMocks.createTrackedFamilyFlight
      .mockRejectedValueOnce(new serviceMocks.FlightStatusError(
        'Flight status is unreachable.',
        'unavailable',
      ))
      .mockResolvedValueOnce(createdResult())
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    let user = await addFlight()
    expect(await screen.findByRole('alert')).toHaveTextContent(/unreachable/i)
    await user.click(screen.getByRole('button', { name: 'Close add flight' }))
    user = await addFlight()
    expect(await screen.findByText('JFK')).toBeInTheDocument()

    expect(serviceMocks.createTrackedFlightId).toHaveBeenCalledTimes(1)
    expect(serviceMocks.createTrackedFamilyFlight.mock.calls[0][0].id)
      .toBe(serviceMocks.createTrackedFamilyFlight.mock.calls[1][0].id)
  })

  it('unfolds an accessible route map in the card and refreshes from its icon', async () => {
    const { container } = render(
      <FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />,
    )
    const user = await addFlight()
    await expandFlightInfo(user, 'EK202')

    expect(screen.getByRole('region', { name: 'EK202 full flight information' }))
      .toBeInTheDocument()
    expect(container.querySelectorAll('.flight-card__route, .flight-detail__route'))
      .toHaveLength(1)
    expect(screen.queryByRole('group', { name: 'JFK to DXB' }))
      .not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'EK202' })).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: /route from JFK to DXB/i })).toBeInTheDocument()
    expect(screen.getByText(/estimated timeline position, not live GPS/i)).toBeInTheDocument()
    expect(screen.getByText(/Updated .* · AeroDataBox/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh EK202' }))
    await waitFor(() => expect(serviceMocks.refreshTrackedFamilyFlight).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'EK202',
      { signal: expect.any(AbortSignal) },
    ))
  })

  it('lets inline flight info collapse during refresh and applies the late result', async () => {
    let resolveRefresh!: (value: FlightStatusSnapshot) => void
    serviceMocks.refreshTrackedFamilyFlight.mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve
    }))
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    await expandFlightInfo(user, 'EK202')
    await user.click(screen.getByRole('button', { name: 'Refresh EK202' }))
    await user.click(screen.getByRole('button', { name: 'Hide all info for EK202' }))
    expect(screen.queryByRole('region', { name: 'EK202 full flight information' }))
      .not.toBeInTheDocument()
    await act(async () => resolveRefresh({ ...status, status: 'Boarding' }))
    expect(serviceMocks.refreshTrackedFamilyFlight.mock.calls[0][2].signal.aborted)
      .toBe(false)
    expect(await screen.findByRole('status')).toHaveTextContent(/was updated/i)
  })

  it('keeps FlightAware attribution on a legacy cached flight', async () => {
    writeTrackedFlights(testFlightSubject(), [{
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: '2026-09-10',
      createdAt: '2026-08-29T12:00:00.000Z',
      notificationEnabled: false,
      synced: false,
      snapshot: {
        ...status,
        provider: 'flightaware',
        providerFlightId: 'UAE202-1',
      },
    }])

    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = userEvent.setup()
    await expandFlightInfo(user, 'EK202')

    expect(screen.getByText(/Updated .* · FlightAware AeroAPI/i)).toBeInTheDocument()
  })

  it('requests alerts only after the user explicitly opts in', async () => {
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    expect(notificationMocks.enableFlightNotifications).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Turn on alerts for EK202' }))

    expect(notificationMocks.enableFlightNotifications).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Turn off alerts for EK202' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(/alerts set on this phone/i)
  })

  it('serializes alert and refresh controls across same-tick taps', async () => {
    let resolveAlerts!: (value: FlightNotificationResult) => void
    notificationMocks.enableFlightNotifications.mockReturnValueOnce(new Promise((resolve) => {
      resolveAlerts = resolve
    }))
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    await addFlight()
    const alertButton = screen.getByRole('button', {
      name: 'Turn on alerts for EK202',
    })

    act(() => {
      alertButton.click()
      alertButton.click()
    })

    expect(notificationMocks.enableFlightNotifications).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Changing alerts for EK202' }))
      .toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh EK202' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop tracking EK202' })).toBeDisabled()

    await act(async () => resolveAlerts({
      enabled: true,
      mode: 'native',
      message: 'Departure and arrival alerts set on this phone.',
    }))
    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Turn off alerts for EK202',
    })).toBeEnabled())

    let resolveRefresh!: (value: FlightStatusSnapshot) => void
    serviceMocks.refreshTrackedFamilyFlight.mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve
    }))
    act(() => screen.getByRole('button', { name: 'Refresh EK202' }).click())

    expect(screen.getByRole('button', { name: 'Refreshing EK202' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Turn off alerts for EK202' }))
      .toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop tracking EK202' })).toBeDisabled()
    await act(async () => resolveRefresh({ ...status, status: 'Boarding' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/was updated/i)
  })

  it('stops a shared tracker only after the server authorizes deletion', async () => {
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    await user.click(screen.getByRole('button', { name: 'Stop tracking EK202' }))
    expect(serviceMocks.removeFamilyFlight).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Yes, stop tracking' }))

    await waitFor(() => expect(serviceMocks.removeFamilyFlight).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { signal: expect.any(AbortSignal) },
    ))
    expect(notificationMocks.cancelFlightNotifications).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      testFlightSubject(),
    )
    expect(screen.queryByRole('button', {
      name: /all info for EK202/,
    })).not.toBeInTheDocument()
  })

  it('keeps delete confirmation stable while server authorization is pending', async () => {
    let resolveDelete!: (value: boolean) => void
    serviceMocks.removeFamilyFlight.mockReturnValueOnce(new Promise((resolve) => {
      resolveDelete = resolve
    }))
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    await user.click(screen.getByRole('button', { name: 'Stop tracking EK202' }))
    const confirm = screen.getByRole('button', { name: 'Yes, stop tracking' })

    act(() => {
      confirm.click()
      confirm.click()
    })

    expect(serviceMocks.removeFamilyFlight).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Keep flight' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Hide all info for EK202' }))
      .toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh EK202' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Turn on alerts for EK202' }))
      .toBeDisabled()

    await act(async () => resolveDelete(true))
    await waitFor(() => expect(screen.queryByText('EK202')).not.toBeInTheDocument())
  })

  it('keeps the card when an in-flight delete is aborted by unmounting', async () => {
    let resolveDelete!: (value: boolean) => void
    serviceMocks.removeFamilyFlight.mockReturnValueOnce(new Promise((resolve) => {
      resolveDelete = resolve
    }))
    const { unmount } = render(
      <FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />,
    )
    const user = await addFlight()
    await user.click(screen.getByRole('button', { name: 'Stop tracking EK202' }))
    await user.click(screen.getByRole('button', { name: 'Yes, stop tracking' }))
    unmount()
    await act(async () => resolveDelete(true))
    expect(serviceMocks.removeFamilyFlight.mock.calls[0][1].signal.aborted)
      .toBe(true)

    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    expect(screen.getByRole('button', { name: 'Show all info for EK202' }))
      .toBeInTheDocument()
  })

  it('keeps a shared card and reports a connection failure distinctly', async () => {
    serviceMocks.removeFamilyFlight.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    await user.click(screen.getByRole('button', { name: 'Stop tracking EK202' }))
    await user.click(screen.getByRole('button', { name: 'Yes, stop tracking' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/while offline/i)
    expect(screen.getByRole('button', { name: 'Hide all info for EK202' }))
      .toBeInTheDocument()
    expect(notificationMocks.cancelFlightNotifications).not.toHaveBeenCalled()
  })

  it('keeps automatic refreshes within a shared rolling budget', async () => {
    const remoteFlights = Array.from({ length: 8 }, (_, index) => ({
      id: `remote-flight-${index}`,
      travelerName: `Traveler ${index + 1}`,
      flightNumber: 'EK202',
      travelDate: '2026-09-10',
      createdAt: '2026-08-29T12:00:00.000Z',
      notificationEnabled: false,
      synced: true,
      snapshot: status,
    }))
    serviceMocks.fetchFamilyFlights.mockResolvedValue(remoteFlights)

    const { rerender, unmount } = render(
      <FlightTrackerSection now={new Date('2026-09-10T09:00:00Z')} />,
    )

    await waitFor(() => expect(serviceMocks.refreshTrackedFamilyFlight).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    expect(serviceMocks.refreshTrackedFamilyFlight).toHaveBeenCalledTimes(2)

    rerender(<FlightTrackerSection now={new Date('2026-09-10T09:01:00Z')} />)
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    expect(serviceMocks.refreshTrackedFamilyFlight).toHaveBeenCalledTimes(2)

    unmount()
    const remounted = render(
      <FlightTrackerSection now={new Date('2026-09-10T09:03:00Z')} />,
    )
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    expect(serviceMocks.refreshTrackedFamilyFlight).toHaveBeenCalledTimes(2)

    identityMocks.familyId = 'family_next'
    remounted.rerender(
      <FlightTrackerSection now={new Date('2026-09-10T09:04:00Z')} />,
    )
    await waitFor(() => expect(serviceMocks.refreshTrackedFamilyFlight).toHaveBeenCalledTimes(4))
  })

  it('does not let an automatic ETA reschedule turn alerts back on', async () => {
    const tracked = {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: '2026-09-10',
      createdAt: '2026-08-29T12:00:00.000Z',
      notificationEnabled: true,
      synced: true,
      snapshot: status,
    }
    writeTrackedFlights(testFlightSubject(), [tracked])
    serviceMocks.fetchFamilyFlights.mockResolvedValue([tracked])
    let resolveRefresh!: (value: FlightStatusSnapshot) => void
    serviceMocks.refreshTrackedFamilyFlight.mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve
    }))
    let resolveReschedule!: (value: boolean) => void
    notificationMocks.rescheduleFlightNotifications.mockReturnValueOnce(new Promise((resolve) => {
      resolveReschedule = resolve
    }))
    render(<FlightTrackerSection now={new Date('2026-09-10T09:00:00Z')} />)

    await waitFor(() => expect(serviceMocks.refreshTrackedFamilyFlight)
      .toHaveBeenCalledTimes(1))
    await act(async () => resolveRefresh({
      ...status,
      updatedAt: '2026-09-10T09:00:00.000Z',
    }))
    await waitFor(() => expect(notificationMocks.rescheduleFlightNotifications)
      .toHaveBeenCalledTimes(1))

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Turn off alerts for EK202' }))
    expect(screen.getByRole('button', { name: 'Turn on alerts for EK202' }))
      .toHaveAttribute('aria-pressed', 'false')
    const cancellationsBeforeLateSchedule = notificationMocks.cancelFlightNotifications.mock.calls.length

    await act(async () => resolveReschedule(true))

    await waitFor(() => expect(notificationMocks.cancelFlightNotifications.mock.calls.length)
      .toBeGreaterThan(cancellationsBeforeLateSchedule))
    expect(screen.getByRole('button', { name: 'Turn on alerts for EK202' }))
      .toHaveAttribute('aria-pressed', 'false')
    expect(localStorage.getItem(flightStorageKey(testFlightSubject())))
      .toContain('"notificationEnabled":false')
  })

  it('isolates cached flights and cancels old alerts when the family changes', async () => {
    const oldSubject = familyFlightStorageSubject('user_test', 'family_old')
    writeTrackedFlights(oldSubject, [{
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      travelerName: 'Old family traveler',
      flightNumber: 'EK202',
      travelDate: '2026-09-10',
      createdAt: '2026-08-29T12:00:00.000Z',
      notificationEnabled: true,
      synced: true,
      snapshot: status,
    }])
    writeActiveFlightStorageSubject(oldSubject)

    identityMocks.familyId = 'family_new'
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)

    expect(screen.queryByText('Old family traveler')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No journeys on the board yet' })).toBeInTheDocument()
    await waitFor(() => expect(notificationMocks.cancelFlightNotifications).toHaveBeenCalledWith(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      oldSubject,
    ))
    expect(localStorage.getItem(flightStorageKey(testFlightSubject()))).toBe('[]')
  })

  it('does not let a stale family fetch erase a newly-created synced flight', async () => {
    let resolveFetch!: (flights: never[]) => void
    serviceMocks.fetchFamilyFlights.mockReturnValueOnce(new Promise((resolve) => {
      resolveFetch = resolve
    }))

    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    await addFlight()
    expect(await screen.findByText('JFK')).toBeInTheDocument()

    await act(async () => resolveFetch([]))

    expect(screen.getByText('JFK')).toBeInTheDocument()
    expect(localStorage.getItem(flightStorageKey(testFlightSubject()))).toContain('EK202')
  })

  it('upserts by ID when realtime hydration wins the create response race', async () => {
    const hydrated = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: '2026-09-10',
      createdAt: '2026-08-29T11:00:00.000Z',
      notificationEnabled: false,
      synced: true,
      snapshot: { ...status, status: 'Hydrated' },
    }
    serviceMocks.fetchFamilyFlights.mockResolvedValueOnce([hydrated])
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    await screen.findByRole('button', {
      name: 'Show all info for EK202',
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add flight' }))
    await user.type(screen.getByLabelText(/Header/), 'Sara')
    await user.type(screen.getByLabelText('Flight number'), 'EK202')
    await user.type(screen.getByLabelText('Departure date'), '2026-09-10')
    await user.click(screen.getByRole('button', { name: 'Track flight' }))

    expect(await screen.findAllByRole('button', {
      name: /all info for EK202/,
    })).toHaveLength(1)
  })

  it('explains owner permission errors without removing the shared card', async () => {
    serviceMocks.removeFamilyFlight.mockRejectedValueOnce(
      new Error('flight_delete_not_allowed'),
    )
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    await user.click(screen.getByRole('button', { name: 'Stop tracking EK202' }))
    await user.click(screen.getByRole('button', { name: 'Yes, stop tracking' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/family owner/i)
    expect(screen.getByRole('button', { name: 'Hide all info for EK202' }))
      .toBeInTheDocument()
  })

  it('downgrades stale Live data in the visible card', () => {
    localStorage.setItem(flightStorageKey(testFlightSubject()), JSON.stringify([{
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: '2026-09-10',
      createdAt: '2026-08-29T12:00:00.000Z',
      notificationEnabled: false,
      synced: false,
      snapshot: {
        ...status,
        dataQuality: 'live',
        position: {
          latitude: 45,
          longitude: 10,
          altitudeFeet: 35_000,
          headingDegrees: 90,
          recordedAt: '2026-08-29T11:30:00.000Z',
        },
      },
    }]))

    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    expect(screen.getByText('Estimated')).toBeInTheDocument()
    expect(screen.queryByText('Live')).not.toBeInTheDocument()
  })

  it('shows a cancelled state without progress, ETA, map marker, or alerts', async () => {
    writeTrackedFlights(testFlightSubject(), [{
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: '2026-09-10',
      createdAt: '2026-08-29T12:00:00.000Z',
      notificationEnabled: true,
      synced: false,
      snapshot: { ...status, status: 'Cancelled' },
    }])
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByText('Not applicable')).toBeInTheDocument()
    expect(screen.getByText('No ETA')).toBeInTheDocument()
    await waitFor(() => expect(notificationMocks.cancelFlightNotifications)
      .toHaveBeenCalledWith('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', testFlightSubject()))

    const user = userEvent.setup()
    await expandFlightInfo(user, 'EK202')
    expect(screen.getByRole('button', { name: 'Alerts unavailable for cancelled EK202' }))
      .toBeDisabled()
    expect(screen.getAllByText('Not applicable')).toHaveLength(2)
    expect(screen.queryByRole('img', { name: /route from/i })).not.toBeInTheDocument()
    expect(screen.getByText(/no aircraft position or route progress/i)).toBeInTheDocument()
  })

  it('ticks journey progress each minute when time is not controlled by a parent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T10:01:00.000Z'))
    localStorage.setItem(flightStorageKey(testFlightSubject()), JSON.stringify([{
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: '2026-09-10',
      createdAt: '2026-08-29T12:00:00.000Z',
      notificationEnabled: false,
      synced: false,
      snapshot: {
        ...status,
        dataQuality: 'estimated',
        actualDeparture: '2026-09-10T10:00:00.000Z',
        scheduledDeparture: '2026-09-10T10:00:00.000Z',
        scheduledArrival: '2026-09-10T10:10:00.000Z',
        estimatedArrival: '2026-09-10T10:10:00.000Z',
        progressPercent: null,
        updatedAt: '2026-09-10T10:01:00.000Z',
      },
    }]))

    render(<FlightTrackerSection />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10')
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20')
    vi.useRealTimers()
  })
})
