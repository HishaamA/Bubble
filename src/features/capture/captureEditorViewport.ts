export type CaptureEditorViewportGeometry = {
  height: number
}

function isPositiveDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function readCaptureEditorViewport(
  target: Window = window,
): CaptureEditorViewportGeometry {
  const viewport = target.visualViewport
  const height = viewport?.height

  return {
    height: isPositiveDimension(height)
      ? height
      : isPositiveDimension(target.innerHeight)
        ? target.innerHeight
        : 1,
  }
}

export function applyCaptureEditorViewport(
  element: HTMLElement,
  geometry: CaptureEditorViewportGeometry,
): void {
  element.style.setProperty(
    '--capture-editor-viewport-height',
    `${geometry.height}px`,
  )
  element.dataset.compactEditor = geometry.height <= 560 ? 'true' : 'false'
}

export function installCaptureEditorViewportSync(
  element: HTMLElement,
  target: Window = window,
): () => void {
  const sync = () => {
    applyCaptureEditorViewport(element, readCaptureEditorViewport(target))
  }
  const visualViewport = target.visualViewport

  target.addEventListener('resize', sync)
  target.addEventListener('orientationchange', sync)
  visualViewport?.addEventListener('resize', sync)
  visualViewport?.addEventListener('scroll', sync)
  sync()

  return () => {
    target.removeEventListener('resize', sync)
    target.removeEventListener('orientationchange', sync)
    visualViewport?.removeEventListener('resize', sync)
    visualViewport?.removeEventListener('scroll', sync)
    element.style.removeProperty('--capture-editor-viewport-height')
    delete element.dataset.compactEditor
  }
}
