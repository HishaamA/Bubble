export type FlightDataQuality = 'live' | 'estimated' | 'scheduled'

export type FlightProvider = 'flightaware' | 'aerodatabox'

export type FlightCoordinates = {
  latitude: number
  longitude: number
}

export type FlightAirport = FlightCoordinates & {
  code: string
  name: string | null
  city: string | null
  timeZone: string
}

export type FlightStatusSnapshot = {
  provider: FlightProvider
  providerFlightId: string | null
  flightNumber: string
  operatingFlightNumber?: string | null
  status: string
  dataQuality: FlightDataQuality
  origin: FlightAirport
  destination: FlightAirport
  scheduledDeparture: string | null
  estimatedDeparture: string | null
  actualDeparture: string | null
  scheduledArrival: string | null
  estimatedArrival: string | null
  actualArrival: string | null
  progressPercent: number | null
  position: (FlightCoordinates & {
    altitudeFeet: number | null
    headingDegrees: number | null
    recordedAt: string | null
  }) | null
  updatedAt: string
}

export type TrackedFlight = {
  id: string
  travelerName: string
  flightNumber: string
  travelDate: string
  createdAt: string
  snapshot: FlightStatusSnapshot
  notificationEnabled: boolean
  synced: boolean
}

export type FlightFormInput = {
  travelerName: string
  flightNumber: string
  travelDate: string
}
