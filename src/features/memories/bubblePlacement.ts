/** Normalized root position inside the constellation world. */
export type BubblePlacement = { top: number; left: number }
export type BubblePlacementMap = Record<string, BubblePlacement>

export const BUBBLE_PLACEMENT_STORAGE_KEY =
  'kinsphere.memory-bubble-placements.v1'

/** Accepts only normalized finite coordinates read from browser storage. */
function validCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  )
}

/** Parses persisted placements and drops malformed or out-of-range entries. */
export function parseBubblePlacements(value: string | null): BubblePlacementMap {
  if (!value) return {}

  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([id, placement]) => {
        if (
          !id ||
          !placement ||
          typeof placement !== 'object' ||
          Array.isArray(placement)
        ) {
          return []
        }
        const { top, left } = placement as { top?: unknown; left?: unknown }
        return validCoordinate(top) && validCoordinate(left)
          ? [[id, { top, left } satisfies BubblePlacement]]
          : []
      }),
    )
  } catch {
    return {}
  }
}

/** Reads placements without allowing unavailable WebView storage to break UI. */
export function readBubblePlacements(
  storage: Pick<Storage, 'getItem'> | null =
    typeof window === 'undefined' ? null : window.localStorage,
): BubblePlacementMap {
  if (!storage) return {}
  try {
    return parseBubblePlacements(storage.getItem(BUBBLE_PLACEMENT_STORAGE_KEY))
  } catch {
    return {}
  }
}

/** Persists all placements when browser storage is available. */
export function saveBubblePlacements(
  placements: BubblePlacementMap,
  storage: Pick<Storage, 'setItem'> | null =
    typeof window === 'undefined' ? null : window.localStorage,
): void {
  if (!storage) return
  try {
    storage.setItem(BUBBLE_PLACEMENT_STORAGE_KEY, JSON.stringify(placements))
  } catch {
    // A restricted WebView can disable local storage. Movement still works
    // for the current render even when its placement cannot be persisted.
  }
}

/** Keeps a bubble's pixel position within the current constellation world. */
export function constrainBubblePosition({
  requested,
  bubble,
  world,
}: {
  requested: { top: number; left: number }
  bubble: { width: number; height: number }
  world: { width: number; height: number }
}): { top: number; left: number } {
  if (world.width <= 0 || world.height <= 0) return requested

  return {
    left: Math.min(
      Math.max(0, world.width - bubble.width),
      Math.max(0, requested.left),
    ),
    top: Math.min(
      Math.max(0, world.height - bubble.height),
      Math.max(0, requested.top),
    ),
  }
}

/** Converts a pixel position into a device-independent percentage placement. */
export function normalizeBubblePosition(
  position: { top: number; left: number },
  world: { width: number; height: number },
): BubblePlacement {
  return {
    top: world.height > 0 ? (position.top / world.height) * 100 : 0,
    left: world.width > 0 ? (position.left / world.width) * 100 : 0,
  }
}
