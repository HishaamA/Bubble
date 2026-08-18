import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

async function addFlight() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Track a flight' }))
  await user.type(screen.getByLabelText('Traveler'), 'Sara')
  await user.type(screen.getByLabelText('Flight number'), 'ek 202')
  await user.type(screen.getByLabelText('Departure or arrival date'), '2026-09-10')
  await user.click(screen.getByRole('button', { name: 'Track flight' }))
  return user
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  identityMocks.userId = 'user_test'
  identityMocks.familyId = 'family_test'
  serviceMocks.fetchFamilyFlights.mockResolvedValue([])
  serviceMocks.createTrackedFamilyFlight.mockResolvedValue(status)
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
    expect(screen.getByRole('heading', { name: 'No flights tracked' })).toBeInTheDocument()
    expect(screen.queryByText('EK202')).not.toBeInTheDocument()
  })

  it('explains why a ticket number cannot be used and never stores it', async () => {
    const user = userEvent.setup()
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    await user.click(screen.getByRole('button', { name: 'Track a flight' }))
    expect(screen.getByText(/codeshares are matched automatically/i)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Traveler'), 'Sara')
    await user.type(screen.getByLabelText('Flight number'), '1761234567890')
    await user.type(screen.getByLabelText('Departure or arrival date'), '2026-09-10')
    await user.click(screen.getByRole('button', { name: 'Track flight' }))

    expect(screen.getByRole('alert')).toHaveTextContent(/public flight trackers/i)
    expect(screen.getByRole('alert')).toHaveTextContent(/never stored/i)
    expect(serviceMocks.createTrackedFamilyFlight).not.toHaveBeenCalled()
    expect(localStorage.getItem(flightStorageKey(testFlightSubject()))).toBe('[]')
    expect(localStorage.getItem(flightStorageKey(testFlightSubject()))).not.toContain('1761234567890')
  })

  it('looks up, stores, and renders a normalized flight card', async () => {
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
    expect(screen.getByRole('progressbar', { name: 'EK202 journey progress' })).toHaveAttribute('aria-valuenow', '0')
    expect(localStorage.getItem(flightStorageKey(testFlightSubject()))).toContain('EK202')
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
    let resolveCreate!: (value: FlightStatusSnapshot) => void
    serviceMocks.createTrackedFamilyFlight.mockReturnValueOnce(new Promise((resolve) => {
      resolveCreate = resolve
    }))
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()

    const close = screen.getByRole('button', { name: 'Close add flight' })
    expect(close).toBeEnabled()
    await user.click(close)
    expect(screen.queryByRole('dialog', { name: 'Track a flight' })).not.toBeInTheDocument()
    await act(async () => resolveCreate(status))
    expect(screen.queryByText('JFK')).not.toBeInTheDocument()
    expect(serviceMocks.createTrackedFamilyFlight.mock.calls[0][1].signal.aborted)
      .toBe(true)
  })

  it('reuses one create ID after an uncertain failure', async () => {
    serviceMocks.createTrackedFamilyFlight
      .mockRejectedValueOnce(new serviceMocks.FlightStatusError(
        'Flight status is unreachable.',
        'unavailable',
      ))
      .mockResolvedValueOnce(status)
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

  it('opens an accessible route map and refreshes status', async () => {
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    await user.click(await screen.findByRole('button', {
      name: 'Open EK202 flight details for Sara',
    }))

    expect(screen.getByRole('dialog', { name: 'EK202' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /route from JFK to DXB/i })).toBeInTheDocument()
    expect(screen.getByText(/estimated timeline position, not live GPS/i)).toBeInTheDocument()
    expect(screen.getByText(/Updated .* · AeroDataBox/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh status' }))
    await waitFor(() => expect(serviceMocks.refreshTrackedFamilyFlight).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'EK202',
      { signal: expect.any(AbortSignal) },
    ))
  })

  it('lets flight details close during refresh and aborts the request', async () => {
    let resolveRefresh!: (value: FlightStatusSnapshot) => void
    serviceMocks.refreshTrackedFamilyFlight.mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve
    }))
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    await user.click(await screen.findByRole('button', {
      name: 'Open EK202 flight details for Sara',
    }))
    await user.click(screen.getByRole('button', { name: 'Refresh status' }))
    const close = screen.getByRole('button', { name: 'Close flight details' })
    expect(close).toBeEnabled()
    await user.click(close)
    expect(screen.queryByRole('dialog', { name: 'EK202' })).not.toBeInTheDocument()
    await act(async () => resolveRefresh({ ...status, status: 'Boarding' }))
    expect(serviceMocks.refreshTrackedFamilyFlight.mock.calls[0][2].signal.aborted)
      .toBe(true)
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
    await user.click(screen.getByRole('button', {
      name: 'Open EK202 flight details for Sara',
    }))

    expect(screen.getByText(/Updated .* · FlightAware AeroAPI/i)).toBeInTheDocument()
  })

  it('requests alerts only after the user explicitly opts in', async () => {
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    expect(notificationMocks.enableFlightNotifications).not.toHaveBeenCalled()

    await user.click(await screen.findByRole('button', { name: 'Notify me about EK202' }))

    expect(notificationMocks.enableFlightNotifications).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Turn off alerts for EK202' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(/alerts set on this phone/i)
  })

  it('stops a shared tracker only after the server authorizes deletion', async () => {
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    await user.click(await screen.findByRole('button', {
      name: 'Open EK202 flight details for Sara',
    }))
    await user.click(screen.getByRole('button', { name: 'Stop tracking this flight' }))
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
      name: 'Open EK202 flight details for Sara',
    })).not.toBeInTheDocument()
  })

  it('keeps the card when delete is closed and ignores a late success', async () => {
    let resolveDelete!: (value: boolean) => void
    serviceMocks.removeFamilyFlight.mockReturnValueOnce(new Promise((resolve) => {
      resolveDelete = resolve
    }))
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    await user.click(await screen.findByRole('button', {
      name: 'Open EK202 flight details for Sara',
    }))
    await user.click(screen.getByRole('button', { name: 'Stop tracking this flight' }))
    await user.click(screen.getByRole('button', { name: 'Yes, stop tracking' }))
    const close = screen.getByRole('button', { name: 'Close flight details' })
    expect(close).toBeEnabled()
    await user.click(close)
    expect(screen.getByRole('button', {
      name: 'Open EK202 flight details for Sara',
    })).toBeInTheDocument()
    await act(async () => resolveDelete(true))
    expect(screen.getByRole('button', {
      name: 'Open EK202 flight details for Sara',
    })).toBeInTheDocument()
    expect(serviceMocks.removeFamilyFlight.mock.calls[0][1].signal.aborted)
      .toBe(true)
  })

  it('keeps a shared card and reports a connection failure distinctly', async () => {
    serviceMocks.removeFamilyFlight.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    await user.click(await screen.findByRole('button', {
      name: 'Open EK202 flight details for Sara',
    }))
    await user.click(screen.getByRole('button', { name: 'Stop tracking this flight' }))
    await user.click(screen.getByRole('button', { name: 'Yes, stop tracking' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/while offline/i)
    expect(screen.getByRole('dialog', { name: 'EK202' })).toBeInTheDocument()
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
    expect(screen.getByRole('heading', { name: 'No flights tracked' })).toBeInTheDocument()
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
      name: 'Open EK202 flight details for Sara',
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add flight' }))
    await user.type(screen.getByLabelText('Traveler'), 'Sara')
    await user.type(screen.getByLabelText('Flight number'), 'EK202')
    await user.type(screen.getByLabelText('Departure or arrival date'), '2026-09-10')
    await user.click(screen.getByRole('button', { name: 'Track flight' }))

    expect(await screen.findAllByRole('button', {
      name: 'Open EK202 flight details for Sara',
    })).toHaveLength(1)
  })

  it('explains owner permission errors without removing the shared card', async () => {
    serviceMocks.removeFamilyFlight.mockRejectedValueOnce(
      new Error('flight_delete_not_allowed'),
    )
    render(<FlightTrackerSection now={new Date('2026-08-29T12:00:00Z')} />)
    const user = await addFlight()
    await user.click(await screen.findByRole('button', {
      name: 'Open EK202 flight details for Sara',
    }))
    await user.click(screen.getByRole('button', { name: 'Stop tracking this flight' }))
    await user.click(screen.getByRole('button', { name: 'Yes, stop tracking' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/family owner/i)
    expect(screen.getByRole('dialog', { name: 'EK202' })).toBeInTheDocument()
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
    expect(screen.getByText('No ETA')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /alerts unavailable for cancelled/i }))
      .toBeDisabled()
    await waitFor(() => expect(notificationMocks.cancelFlightNotifications)
      .toHaveBeenCalledWith('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', testFlightSubject()))

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', {
      name: 'Open EK202 flight details for Sara',
    }))
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
