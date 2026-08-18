import { afterEach, describe, expect, it } from 'vitest'
import {
  familyFlightStorageSubject,
  flightStorageKey,
  getOrCreatePendingFlightCreateId,
  clearPendingFlightCreateIntent,
  mergeTrackedFlights,
  readActiveFlightStorageSubject,
  readTrackedFlights,
  writeActiveFlightStorageSubject,
  writeTrackedFlights,
} from './flightStorage'
import type { TrackedFlight } from './types'

const flight: TrackedFlight = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  travelerName: 'Sara',
  flightNumber: 'EK202',
  travelDate: '2026-09-10',
  createdAt: '2026-08-29T12:00:00.000Z',
  notificationEnabled: false,
  synced: false,
  snapshot: {
    provider: 'flightaware',
    providerFlightId: 'UAE202-1',
    flightNumber: 'EK202',
    status: 'Scheduled',
    dataQuality: 'scheduled',
    origin: { code: 'JFK', name: null, city: 'New York', latitude: 40.6, longitude: -73.7, timeZone: 'America/New_York' },
    destination: { code: 'DXB', name: null, city: 'Dubai', latitude: 25.2, longitude: 55.3, timeZone: 'Asia/Dubai' },
    scheduledDeparture: '2026-09-10T10:00:00.000Z',
    estimatedDeparture: null,
    actualDeparture: null,
    scheduledArrival: '2026-09-10T20:00:00.000Z',
    estimatedArrival: null,
    actualArrival: null,
    progressPercent: 0,
    position: null,
    updatedAt: '2026-08-29T12:00:00.000Z',
  },
}

afterEach(() => localStorage.clear())

describe('flight storage', () => {
  it('keeps flights isolated by account and family', () => {
    const familyA = familyFlightStorageSubject('user_A', 'family_A')
    const familyB = familyFlightStorageSubject('user_A', 'family_B')
    writeTrackedFlights(familyA, [flight])
    expect(readTrackedFlights(familyA)).toEqual([flight])
    expect(readTrackedFlights(familyB)).toEqual([])
    expect(localStorage.getItem(flightStorageKey(familyA))).toContain('EK202')
  })

  it('keeps legacy FlightAware and new AeroDataBox snapshots in the v1 cache', () => {
    const aerodataboxFlight: TrackedFlight = {
      ...flight,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      snapshot: {
        ...flight.snapshot,
        provider: 'aerodatabox',
        providerFlightId: '2026-09-10:EK202',
      },
    }

    writeTrackedFlights('user_A', [flight, aerodataboxFlight])

    expect(flightStorageKey('user_A')).toBe('kinsphere-family-flights:v1:user_A')
    expect(readTrackedFlights('user_A')).toEqual([flight, aerodataboxFlight])
  })

  it('rejects snapshots from unknown providers', () => {
    const unknownProvider = {
      ...flight,
      snapshot: { ...flight.snapshot, provider: 'untrusted-provider' },
    } as unknown as TrackedFlight

    writeTrackedFlights('user_A', [unknownProvider])

    expect(readTrackedFlights('user_A')).toEqual([])
  })

  it('persists the last active account-family subject for alert cleanup', () => {
    const subject = familyFlightStorageSubject('user_A', 'family_A')
    expect(readActiveFlightStorageSubject()).toBeNull()
    writeActiveFlightStorageSubject(subject)
    expect(readActiveFlightStorageSubject()).toBe(subject)
  })

  it('does not persist a ticket number even if malformed data reaches storage', () => {
    const unsafe = {
      ...flight,
      flightNumber: '1761234567890',
      snapshot: { ...flight.snapshot, flightNumber: '1761234567890' },
    } as TrackedFlight
    writeTrackedFlights('user_A', [unsafe])
    expect(readTrackedFlights('user_A')).toEqual([])
    expect(localStorage.getItem(flightStorageKey('user_A'))).toBe('[]')
  })

  it('rejects a snapshot that belongs to a different flight identity', () => {
    writeTrackedFlights('user_A', [{
      ...flight,
      snapshot: { ...flight.snapshot, flightNumber: 'EK203' },
    }])
    expect(readTrackedFlights('user_A')).toEqual([])
  })

  it('merges family updates without changing this phone’s alert preference', () => {
    const local = { ...flight, notificationEnabled: true }
    const remote = {
      ...flight,
      synced: true,
      snapshot: { ...flight.snapshot, status: 'Boarding' },
    }
    expect(mergeTrackedFlights([local], [remote])).toEqual([
      expect.objectContaining({
        synced: true,
        notificationEnabled: true,
        snapshot: expect.objectContaining({ status: 'Boarding' }),
      }),
    ])
  })

  it('treats the server as authoritative for synced rows but retains explicit local drafts', () => {
    const removedOnServer = { ...flight, id: 'removed', synced: true }
    const localDraft = { ...flight, id: 'draft', synced: false }
    expect(mergeTrackedFlights([removedOnServer, localDraft], [])).toEqual([
      expect.objectContaining({ id: 'draft', synced: false }),
    ])
  })

  it('reuses a pending create ID until the validated identity is definitive', () => {
    let nextId = 0
    const createId = () => `flight-${++nextId}`
    const identity = {
      travelerName: 'Sara',
      flightNumber: 'EK202',
      travelDate: '2026-09-10',
    }
    expect(getOrCreatePendingFlightCreateId('user_A', identity, createId))
      .toBe('flight-1')
    expect(getOrCreatePendingFlightCreateId('user_A', identity, createId))
      .toBe('flight-1')
    clearPendingFlightCreateIntent('user_A', identity)
    expect(getOrCreatePendingFlightCreateId('user_A', identity, createId))
      .toBe('flight-2')
  })
})
