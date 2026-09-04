const RESERVED_MEMORY_POSITIONS = [
  { top: 7, left: 8 },
  { top: 8, left: 45 },
  { top: 10, left: 78 },
  { top: 29, left: 16 },
  { top: 45, left: 40 },
  { top: 32, left: 83 },
  { top: 62, left: 6 },
  { top: 62, left: 72 },
  { top: 80, left: 49 },
  { top: 84, left: 18 },
] as const

const REFERENCE_FIELD_WIDTH = 320
const REFERENCE_FIELD_HEIGHT = 560
const WORLD_WIDTH_SCALE = 1.4
const BUBBLE_CLEARANCE_PX = 82
const ROW_SPACING_PX = 84
const EVEN_ROW_LEFTS = [3, 22, 41, 60, 79] as const
const ODD_ROW_LEFTS = [12.5, 31.5, 50.5, 69.5] as const

type NumericPosition = { top: number; left: number; slot: number }

/** Wraps a deterministic seed into the normalized 0–1 range. */
function fractionalPart(value: number) {
  return value - Math.floor(value)
}

/** Counts only rows required beyond positions reserved for bundled memories. */
function layoutRowCount(sharedCount: number) {
  if (sharedCount <= 0) return 8
  // Extra slots replace any that are reserved by the built-in memories.
  return Math.max(8, Math.ceil((sharedCount + 20) / 4.5) + 2)
}

/** Returns the world height required to place every shared moment safely. */
export function getSharedMomentWorldHeightPercent(sharedCount: number) {
  const rows = layoutRowCount(Math.max(0, Math.floor(sharedCount)))
  const height = Math.max(
    140,
    (((rows - 1) * ROW_SPACING_PX + 160) / REFERENCE_FIELD_HEIGHT) * 100,
  )
  return Math.round(height * 100) / 100
}

/** Measures clearance in reference-field pixels rather than distorted percentages. */
function renderedDistance(
  first: Pick<NumericPosition, 'top' | 'left'>,
  second: { top: number; left: number },
  worldHeightScale: number,
) {
  const horizontal =
    ((first.left - second.left) * WORLD_WIDTH_SCALE *
      REFERENCE_FIELD_WIDTH) /
    100
  const vertical =
    ((first.top - second.top) * worldHeightScale *
      REFERENCE_FIELD_HEIGHT) /
    100
  return Math.hypot(horizontal, vertical)
}

/**
 * Builds a staggered Apple Watch-like field. Slot centers remain at least one
 * phone-sized bubble apart, while reserved slots keep uploads from covering the
 * built-in memories. Center-first ordering keeps small families feeling close.
 */
export function getSharedMomentPositions(sharedCount: number) {
  const count = Math.max(0, Math.floor(sharedCount))
  if (count === 0) return []

  const rows = layoutRowCount(count)
  const worldHeightPercent = getSharedMomentWorldHeightPercent(count)
  const worldHeightScale = worldHeightPercent / 100
  const verticalStep =
    (ROW_SPACING_PX / (worldHeightScale * REFERENCE_FIELD_HEIGHT)) * 100
  const candidates: NumericPosition[] = []
  let slot = 0

  for (let row = 0; row < rows; row += 1) {
    const lefts = row % 2 === 0 ? EVEN_ROW_LEFTS : ODD_ROW_LEFTS
    for (const left of lefts) {
      const candidate = { top: 3 + row * verticalStep, left, slot }
      slot += 1
      if (
        RESERVED_MEMORY_POSITIONS.every(
          (reserved) =>
            renderedDistance(candidate, reserved, worldHeightScale) >=
            BUBBLE_CLEARANCE_PX,
        )
      ) {
        candidates.push(candidate)
      }
    }
  }

  candidates.sort((first, second) => {
    const center = { top: 50, left: 40 }
    const centerDifference =
      renderedDistance(first, center, worldHeightScale) -
      renderedDistance(second, center, worldHeightScale)
    if (Math.abs(centerDifference) > 0.01) return centerDifference
    return (
      fractionalPart((first.slot + 1) * 0.618033988749895) -
      fractionalPart((second.slot + 1) * 0.618033988749895)
    )
  })

  if (candidates.length < count) {
    throw new RangeError('The shared moment world could not fit every bubble.')
  }

  return candidates.slice(0, count).map(
    ({ top, left }) =>
      [`${top.toFixed(2)}%`, `${left.toFixed(2)}%`] as const,
  )
}

/** Returns one stable shared-moment slot, expanding the layout when necessary. */
export function getSharedMomentPosition(
  sharedIndex: number,
  sharedCount = sharedIndex + 1,
) {
  const index = Math.max(0, Math.floor(sharedIndex))
  return getSharedMomentPositions(Math.max(sharedCount, index + 1))[index] ?? [
    '50%',
    '50%',
  ]
}
