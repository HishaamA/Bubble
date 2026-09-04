export const NATIVE_VIEWPORT_GEOMETRY_EVENT =
  'kinsphere:native-viewport-geometry'

export type NativeViewportGeometry = {
  safeAreaInsets?: Partial<
    Record<'top' | 'right' | 'bottom' | 'left', number>
  >
  viewport?: {
    width?: number
    height?: number
  }
}

const insetProperties = {
  top: '--native-safe-area-top',
  right: '--native-safe-area-right',
  bottom: '--native-safe-area-bottom',
  left: '--native-safe-area-left',
} as const

/** Rejects malformed inset values received across the native bridge. */
function isSafeInset(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Applies trusted native safe-area insets to document-level CSS variables. */
export function applyNativeViewportGeometry(
  detail: NativeViewportGeometry,
  root: HTMLElement = document.documentElement,
): void {
  const insets = detail.safeAreaInsets
  if (!insets) return

  for (const edge of Object.keys(insetProperties) as Array<
    keyof typeof insetProperties
  >) {
    const value = insets[edge]
    if (!isSafeInset(value)) continue
    root.style.setProperty(insetProperties[edge], `${value}px`)
  }
}

/** Listens for native safe-area updates until the returned cleanup is called. */
export function installNativeViewportGeometrySync(
  target: Window = window,
  root: HTMLElement = document.documentElement,
): () => void {
  const handleGeometry = (event: Event) => {
    const detail = (event as CustomEvent<NativeViewportGeometry>).detail
    if (!detail || typeof detail !== 'object') return
    applyNativeViewportGeometry(detail, root)
  }

  target.addEventListener(NATIVE_VIEWPORT_GEOMETRY_EVENT, handleGeometry)

  return () => {
    target.removeEventListener(NATIVE_VIEWPORT_GEOMETRY_EVENT, handleGeometry)
  }
}
