import { describe, expect, it } from 'vitest'
import {
  BUBBLE_PLACEMENT_STORAGE_KEY,
  constrainBubblePosition,
  normalizeBubblePosition,
  parseBubblePlacements,
  readBubblePlacements,
  saveBubblePlacements,
} from './bubblePlacement'

describe('bubble placement', () => {
  it('keeps only finite, bounded saved coordinates', () => {
    expect(
      parseBubblePlacements(
        JSON.stringify({
          dinner: { top: 42, left: 18 },
          broken: { top: 'far', left: 2 },
          excessive: { top: 101, left: 0 },
        }),
      ),
    ).toEqual({ dinner: { top: 42, left: 18 } })
    expect(parseBubblePlacements('{')).toEqual({})
  })

  it('persists placements without failing when storage is unavailable', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    const placements = { dinner: { top: 18, left: 24 } }

    saveBubblePlacements(placements, storage)
    expect(values.has(BUBBLE_PLACEMENT_STORAGE_KEY)).toBe(true)
    expect(readBubblePlacements(storage)).toEqual(placements)
  })

  it('keeps a moved bubble anchor inside the constellation world', () => {
    expect(
      constrainBubblePosition({
        requested: { left: 900, top: -500 },
        bubble: { width: 80, height: 80 },
        world: { width: 500, height: 700 },
      }),
    ).toEqual({ left: 420, top: 0 })
    expect(
      normalizeBubblePosition(
        { left: 210, top: 350 },
        { width: 420, height: 700 },
      ),
    ).toEqual({ left: 50, top: 50 })
  })
})
