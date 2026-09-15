/**
 * The original five quiet, schematic land silhouettes in 360 × 180 map space.
 * Only North America's two northeast vertices extend slightly east so JFK's
 * unchanged projected marker meets the land. These are intentionally not
 * geographic coastlines; avoid adding islands, borders, or geographic detail.
 * Keep these same coordinates in the iOS and Android widget mini-maps.
 */
export const flightLandRings: readonly (readonly { x: number; y: number }[])[] = [
  [
    { x: 8, y: 55 }, { x: 22, y: 41 }, { x: 44, y: 33 }, { x: 103, y: 40 },
    { x: 112, y: 57 }, { x: 72, y: 72 }, { x: 52, y: 76 }, { x: 40, y: 98 },
    { x: 22, y: 103 }, { x: 13, y: 83 },
  ],
  [
    { x: 81, y: 123 }, { x: 97, y: 131 }, { x: 106, y: 155 },
    { x: 101, y: 173 }, { x: 91, y: 154 }, { x: 79, y: 142 },
  ],
  [
    { x: 142, y: 41 }, { x: 164, y: 24 }, { x: 193, y: 19 }, { x: 211, y: 28 },
    { x: 239, y: 24 }, { x: 263, y: 34 }, { x: 280, y: 52 }, { x: 273, y: 64 },
    { x: 248, y: 59 }, { x: 232, y: 71 }, { x: 212, y: 65 }, { x: 197, y: 80 },
    { x: 180, y: 73 }, { x: 170, y: 52 }, { x: 148, y: 54 },
  ],
  [
    { x: 231, y: 106 }, { x: 246, y: 92 }, { x: 270, y: 97 }, { x: 289, y: 121 },
    { x: 277, y: 147 }, { x: 259, y: 155 }, { x: 246, y: 136 }, { x: 227, y: 129 },
  ],
  [
    { x: 299, y: 63 }, { x: 318, y: 49 }, { x: 342, y: 52 },
    { x: 352, y: 65 }, { x: 343, y: 75 }, { x: 317, y: 74 },
  ],
]

/** Build once, not on each flight progress tick; all themes keep their existing ink. */
export const flightLandPath = flightLandRings.map((ring) => (
  ring.map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'}${x} ${y}`).join(' ')
  + 'Z'
)).join(' ')
