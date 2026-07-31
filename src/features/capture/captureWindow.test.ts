import { describe, expect, it } from 'vitest'
import { createDailyCaptureWindow, getDailyCapturePhase } from './captureWindow'

describe('daily capture window', () => {
  it('creates a stable surprise window for the same family and local day', () => {
    const day = new Date(2026, 7, 26, 8, 15)
    const first = createDailyCaptureWindow(day, 'family-a')
    const second = createDailyCaptureWindow(new Date(2026, 7, 26, 20, 45), 'family-a')

    expect(second.startsAt.getTime()).toBe(first.startsAt.getTime())
    expect(second.endsAt.getTime() - second.startsAt.getTime()).toBe(15 * 60_000)
    expect(first.startsAt.getHours()).toBeGreaterThanOrEqual(9)
    expect(first.endsAt.getHours()).toBeLessThanOrEqual(21)
  })

  it('reports upcoming, open, closed, and completed states', () => {
    const window = {
      startsAt: new Date('2026-08-26T12:00:00'),
      endsAt: new Date('2026-08-26T12:15:00'),
    }

    expect(getDailyCapturePhase(new Date('2026-08-26T11:59:00'), window)).toBe('upcoming')
    expect(getDailyCapturePhase(new Date('2026-08-26T12:04:00'), window)).toBe('open')
    expect(getDailyCapturePhase(new Date('2026-08-26T12:15:00'), window)).toBe('closed')
    expect(getDailyCapturePhase(new Date('2026-08-26T12:04:00'), window, true)).toBe('complete')
  })
})
