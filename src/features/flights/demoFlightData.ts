import {
  readTrackedFlights,
  writeTrackedFlights,
} from './flightStorage'
import type { FlightAirport, TrackedFlight } from './types'

const demoSeedStoragePrefix = 'kinsphere-family-flights:demo-seeded:v2:'

const dubai: FlightAirport = {
  code: 'DXB',
  name: 'Dubai International',
  city: 'Dubai',
  latitude: 25.2532,
  longitude: 55.3657,
  timeZone: 'Asia/Dubai',
}

const london: FlightAirport = {
  code: 'LHR',
  name: 'Heathrow',
  city: 'London',
  latitude: 51.47,
  longitude: -0.4543,
  timeZone: 'Europe/London',
}

const jeddah: FlightAirport = {
  code: 'JED',
  name: 'King Abdulaziz International',
  city: 'Jeddah',
  latitude: 21.6702,
  longitude: 39.1525,
  timeZone: 'Asia/Riyadh',
}

const cairo: FlightAirport = {
  code: 'CAI',
  name: 'Cairo International',
  city: 'Cairo',
  latitude: 30.1127,
  longitude: 31.4000,
  timeZone: 'Africa/Cairo',
}

function calendarDate(date: Date) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function atUtcTime(base: Date, dayOffset: number, hours: number, minutes: number) {
  return new Date(Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate() + dayOffset,
    hours,
    minutes,
  )).toISOString()
}

export function createDemoTrackedFlights(now = new Date()): TrackedFlight[] {
  const createdAt = now.toISOString()
  const firstTravelDate = calendarDate(new Date(atUtcTime(now, 2, 4, 40)))
  const secondTravelDate = calendarDate(new Date(atUtcTime(now, 4, 13, 25)))

  return [
    {
      id: `demo-flight-ek001-${firstTravelDate}`,
      travelerName: 'Family trip',
      flightNumber: 'EK001',
      travelDate: firstTravelDate,
      createdAt,
      notificationEnabled: false,
      // Demo cards remain local and never call the family deletion endpoint.
      synced: false,
      snapshot: {
        provider: 'aerodatabox',
        providerFlightId: null,
        flightNumber: 'EK001',
        status: 'On time',
        dataQuality: 'estimated',
        origin: dubai,
        destination: london,
        scheduledDeparture: atUtcTime(now, 2, 4, 40),
        estimatedDeparture: atUtcTime(now, 2, 4, 40),
        actualDeparture: null,
        scheduledArrival: atUtcTime(now, 2, 12, 15),
        estimatedArrival: atUtcTime(now, 2, 12, 15),
        actualArrival: null,
        progressPercent: 65,
        position: null,
        updatedAt: createdAt,
      },
    },
    {
      id: `demo-flight-sv301-${secondTravelDate}`,
      travelerName: 'Granddad',
      flightNumber: 'SV301',
      travelDate: secondTravelDate,
      createdAt,
      notificationEnabled: false,
      synced: false,
      snapshot: {
        provider: 'aerodatabox',
        providerFlightId: null,
        flightNumber: 'SV301',
        status: 'Scheduled',
        dataQuality: 'scheduled',
        origin: jeddah,
        destination: cairo,
        scheduledDeparture: atUtcTime(now, 4, 13, 25),
        estimatedDeparture: null,
        actualDeparture: null,
        scheduledArrival: atUtcTime(now, 4, 16, 35),
        estimatedArrival: null,
        actualArrival: null,
        progressPercent: 0,
        position: null,
        updatedAt: createdAt,
      },
    },
  ]
}

/**
 * Seeds the local preview account once. The marker prevents a flight that the
 * user completed from reappearing after the app is reopened.
 */
export function readOrSeedDemoTrackedFlights(subject: string, now = new Date()) {
  const stored = readTrackedFlights(subject)
  const seedKey = `${demoSeedStoragePrefix}${encodeURIComponent(subject)}`
  try {
    if (localStorage.getItem(seedKey) === 'true') return stored
  } catch {
    // A restricted web view can still show an in-memory demo for this mount.
  }

  // Refresh an older, untouched preview fixture when the reference demo is
  // updated. Never replace user-added or family-synced flights.
  if (stored.length > 0 && !stored.every((flight) => (
    !flight.synced && flight.id.startsWith('demo-flight-')
  ))) return stored

  const demoFlights = writeTrackedFlights(subject, createDemoTrackedFlights(now))
  try {
    localStorage.setItem(seedKey, 'true')
  } catch {
    // The flight storage helper already provides an in-memory fallback.
  }
  return demoFlights
}
