import { describe, expect, it } from 'vitest'
import { isPastCapsule, mayPreviewCapsulePhotos, partitionCapsulesByAge } from './capsuleViewModel'
import type { FamilyCapsule } from './types'

const opensAt = '2026-09-12T09:00:00.000Z'
const day = 24 * 60 * 60 * 1000
const openedAt = new Date(opensAt).getTime()

function capsule(id: string, kind: FamilyCapsule['kind'], reveal = opensAt): FamilyCapsule {
  return {
    id, kind, title: id, opensAt: reveal, closesAt: reveal,
    createdAt: '2026-09-01T09:00:00.000Z', createdByName: 'Simreen', photos: [],
  }
}

describe('capsule age presentation', () => {
  it.each(['weekly', 'special'] as const)('previews an unlocked %s for at most four full days', (kind) => {
    const selected = capsule('family-recap', kind)
    expect(mayPreviewCapsulePhotos(selected, new Date(openedAt - 1))).toBe(false)
    expect(mayPreviewCapsulePhotos(selected, new Date(openedAt))).toBe(true)
    expect(mayPreviewCapsulePhotos(selected, new Date(openedAt + 4 * day - 1))).toBe(true)
    expect(mayPreviewCapsulePhotos(selected, new Date(openedAt + 4 * day))).toBe(true)
    expect(mayPreviewCapsulePhotos(selected, new Date(openedAt + 4 * day + 1))).toBe(false)
  })

  it('keeps the four-day preview window independent from the three-day archive grouping', () => {
    const selected = capsule('recent-history', 'weekly')
    const viewingTime = new Date(openedAt + 3.5 * day)
    expect(isPastCapsule(selected, viewingTime)).toBe(true)
    expect(mayPreviewCapsulePhotos(selected, viewingTime)).toBe(true)
  })

  it('never previews photos for unknown release dates or an invalid clock', () => {
    expect(mayPreviewCapsulePhotos({ opensAt: '' }, new Date(openedAt))).toBe(false)
    expect(mayPreviewCapsulePhotos({ opensAt: 'invalid' }, new Date(openedAt))).toBe(false)
    expect(mayPreviewCapsulePhotos({ opensAt }, new Date(Number.NaN))).toBe(false)
  })

  it.each(['weekly', 'special'] as const)('keeps a %s capsule active until strictly after three full days', (kind) => {
    const selected = capsule('family-recap', kind)
    expect(isPastCapsule(selected, new Date(openedAt - 1))).toBe(false)
    expect(isPastCapsule(selected, new Date(openedAt))).toBe(false)
    expect(isPastCapsule(selected, new Date(openedAt + 3 * day - 1))).toBe(false)
    expect(isPastCapsule(selected, new Date(openedAt + 3 * day))).toBe(false)
    expect(isPastCapsule(selected, new Date(openedAt + 3 * day + 1))).toBe(true)
  })

  it('groups weekly and special capsules together without dropping photos or empty capsules', () => {
    const oldWeekly = capsule('old-weekly', 'weekly')
    const freshSpecial = capsule('fresh-special', 'special', '2026-09-15T08:00:00.000Z')
    const oldSpecial = capsule('old-special', 'special')
    const upcomingWeekly = capsule('upcoming-weekly', 'weekly', '2026-09-21T00:00:00.000Z')
    const items = Object.freeze([oldWeekly, freshSpecial, oldSpecial, upcomingWeekly])
    const result = partitionCapsulesByAge(items, new Date('2026-09-15T09:00:00.001Z'))
    expect(result.active).toEqual([freshSpecial, upcomingWeekly])
    expect(result.past).toEqual([oldWeekly, oldSpecial])
    expect(result.past[0]).toBe(oldWeekly)
    expect(items).toEqual([oldWeekly, freshSpecial, oldSpecial, upcomingWeekly])
  })

  it('uses the reveal instant rather than creation day, week label, or the viewing timezone', () => {
    const selected = capsule('demo-day', 'special', '2026-09-12T13:00:00+04:00')
    expect(isPastCapsule(selected, new Date('2026-09-15T11:00:00+02:00'))).toBe(false)
    expect(isPastCapsule(selected, new Date('2026-09-15T11:00:00.001+02:00'))).toBe(true)
  })

  it('does not archive malformed or unknown reveal timestamps', () => {
    expect(isPastCapsule({ opensAt: '' }, new Date(openedAt + 30 * day))).toBe(false)
    expect(isPastCapsule({ opensAt: 'invalid' }, new Date(openedAt + 30 * day))).toBe(false)
    expect(isPastCapsule({ opensAt }, new Date(Number.NaN))).toBe(false)
  })
})
