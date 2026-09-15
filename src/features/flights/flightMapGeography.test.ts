import { describe, expect, it } from 'vitest'
import { flightLandPath, flightLandRings } from './flightMapGeography'
import { projectFlightCoordinates } from './flightMapProjection'

type Point = { x: number; y: number }

function insideRing(point: Point, ring: readonly Point[]) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

describe('minimal schematic flight map', () => {
  it('retains the existing full-world airport projection and vertical inset', () => {
    expect(projectFlightCoordinates({ latitude: 90, longitude: -180 })).toEqual({ x: 0, y: 4 })
    expect(projectFlightCoordinates({ latitude: -90, longitude: 180 })).toEqual({ x: 360, y: 176 })
    expect(projectFlightCoordinates({ latitude: 0, longitude: 0 })).toEqual({ x: 180, y: 90 })
  })

  it('keeps JFK on the northeast shoulder without moving the airport coordinates', () => {
    const jfk = projectFlightCoordinates({ latitude: 40.6413, longitude: -73.7781 })
    expect(jfk.x).toBeCloseTo(106.2219)
    expect(insideRing(jfk, flightLandRings[0])).toBe(true)
  })

  it('preserves the other four original silhouettes exactly', () => {
    expect(flightLandRings.slice(1).map((ring) => ring.map(({ x, y }) => [x, y]))).toEqual([
      [[81, 123], [97, 131], [106, 155], [101, 173], [91, 154], [79, 142]],
      [[142, 41], [164, 24], [193, 19], [211, 28], [239, 24], [263, 34], [280, 52],
        [273, 64], [248, 59], [232, 71], [212, 65], [197, 80], [180, 73], [170, 52], [148, 54]],
      [[231, 106], [246, 92], [270, 97], [289, 121], [277, 147], [259, 155], [246, 136], [227, 129]],
      [[299, 63], [318, 49], [342, 52], [352, 65], [343, 75], [317, 74]],
    ])
  })

  it('uses only five closed, bounded polygons and 45 vertices, with no coastline detail', () => {
    expect(flightLandRings.length).toBe(5)
    expect(flightLandRings.flat().length).toBe(45)
    for (const ring of flightLandRings) {
      expect(ring.length).toBeGreaterThanOrEqual(4)
      for (const { x, y } of ring) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(360)
        expect(y).toBeGreaterThanOrEqual(4)
        expect(y).toBeLessThanOrEqual(176)
      }
    }
    expect(flightLandPath).not.toMatch(/NaN|Infinity/)
    expect(flightLandPath.match(/M/g)?.length).toBe(flightLandRings.length)
    expect(flightLandPath.match(/Z/g)?.length).toBe(flightLandRings.length)
  })

  it('keeps all schematic shapes local instead of bridging the date line', () => {
    for (const ring of flightLandRings) {
      for (let index = 1; index < ring.length; index += 1) {
        const a = ring[index - 1]
        const b = ring[index]
        expect(Math.abs(b.x - a.x)).toBeLessThan(180)
      }
    }
  })
})
