export type AppViewportGeometry = {
  height: number
  offsetTop: number
  keyboardOpen: boolean
}

const KEYBOARD_MINIMUM_DIFFERENCE = 120
const KEYBOARD_MINIMUM_RATIO = 0.16
const UNZOOMED_SCALE_TOLERANCE = 1.05

function positiveDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function nonNegativeDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function readAppViewportGeometry(
  target: Window = window,
): AppViewportGeometry {
  const viewport = target.visualViewport
  const layoutHeight = positiveDimension(target.innerHeight)
    ? target.innerHeight
    : 1
  const visualHeight = positiveDimension(viewport?.height)
    ? viewport.height
    : layoutHeight
  const visualOffsetTop = nonNegativeDimension(viewport?.offsetTop)
    ? viewport.offsetTop
    : 0
  const scale = positiveDimension(viewport?.scale) ? viewport.scale : 1
  const isUnzoomed = scale <= UNZOOMED_SCALE_TOLERANCE
  const height = isUnzoomed ? visualHeight : layoutHeight
  const offsetTop = isUnzoomed ? visualOffsetTop : 0
  const obscuredHeight = Math.max(
    0,
    layoutHeight - visualHeight - visualOffsetTop,
  )
  const keyboardThreshold = Math.max(
    KEYBOARD_MINIMUM_DIFFERENCE,
    layoutHeight * KEYBOARD_MINIMUM_RATIO,
  )

  return {
    height,
    offsetTop,
    keyboardOpen: isUnzoomed && obscuredHeight >= keyboardThreshold,
  }
}

export function applyAppViewportGeometry(
  element: HTMLElement,
  geometry: AppViewportGeometry,
): void {
  element.style.setProperty('--app-visual-viewport-height', `${geometry.height}px`)
  element.style.setProperty('--app-visual-viewport-offset-top', `${geometry.offsetTop}px`)
  element.dataset.keyboardOpen = geometry.keyboardOpen ? 'true' : 'false'
}

export function synchronizeAppViewportGeometry(
  element: HTMLElement,
  target: Window = window,
): void {
  applyAppViewportGeometry(element, readAppViewportGeometry(target))
}

export function installAppViewportGeometrySync(
  element: HTMLElement,
  target: Window = window,
): () => void {
  const synchronize = () => synchronizeAppViewportGeometry(element, target)
  const viewport = target.visualViewport

  target.addEventListener('resize', synchronize)
  target.addEventListener('orientationchange', synchronize)
  viewport?.addEventListener('resize', synchronize)
  viewport?.addEventListener('scroll', synchronize)
  synchronize()

  return () => {
    target.removeEventListener('resize', synchronize)
    target.removeEventListener('orientationchange', synchronize)
    viewport?.removeEventListener('resize', synchronize)
    viewport?.removeEventListener('scroll', synchronize)
    element.style.removeProperty('--app-visual-viewport-height')
    element.style.removeProperty('--app-visual-viewport-offset-top')
    delete element.dataset.keyboardOpen
  }
}

export function blurActiveTextControl(root: Document = document): void {
  const activeElement = root.activeElement
  if (!(activeElement instanceof HTMLElement)) return
  if (!activeElement.matches('input, textarea, select, [contenteditable="true"]')) return
  activeElement.blur()
}
