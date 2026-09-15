import type { FlightCoordinates } from './types'

/** Projects airport/live coordinates into the shared 360 × 180 schematic map. */
export function projectFlightCoordinates({ latitude, longitude }: FlightCoordinates) {
  return {
    x: longitude + 180,
    y: (90 - latitude) / 180 * 172 + 4,
  }
}
