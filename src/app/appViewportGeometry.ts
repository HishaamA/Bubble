export type AppViewportGeometry = {
  height: number
  offsetTop: number
  keyboardOpen: boolean
}

const KEYBOARD_MINIMUM_DIFFERENCE = 120
const KEYBOARD_MINIMUM_RATIO = 0.16
const UNZOOMED_SCALE_TOLERANCE = 1.05
const REVEAL_SETTLE_DELAYS = [120, 320] as const
const TEXT_ENTRY_SELECTOR = [
  'input:not([type="button"]):not([type="checkbox"]):not([type="color"]):not([type="file"]):not([type="hidden"]):not([type="image"]):not([type="radio"]):not([type="range"]):not([type="reset"]):not([type="submit"])',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ')

/** Accepts only usable viewport dimensions from browser APIs. */
function positiveDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Accepts zero-based viewport offsets while rejecting invalid numbers. */
function nonNegativeDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Normalizes the layout and visual viewports into the dimensions used by the
 * persistent app shell. Pinch zoom deliberately uses the layout height so it
 * is not mistaken for the software keyboard.
 */
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

/** Writes normalized viewport state to CSS variables and a semantic data flag. */
export function applyAppViewportGeometry(
  element: HTMLElement,
  geometry: AppViewportGeometry,
): void {
  element.style.setProperty('--app-visual-viewport-height', `${geometry.height}px`)
  element.style.setProperty('--app-visual-viewport-offset-top', `${geometry.offsetTop}px`)
  element.dataset.keyboardOpen = geometry.keyboardOpen ? 'true' : 'false'
}

/** Reads and applies the current browser viewport in one operation. */
export function synchronizeAppViewportGeometry(
  element: HTMLElement,
  target: Window = window,
): void {
  applyAppViewportGeometry(element, readAppViewportGeometry(target))
}

/** Returns whether an element can summon a keyboard or native input picker. */
export function isTextEntryControl(
  value: EventTarget | null,
): value is HTMLElement {
  return value instanceof HTMLElement && value.matches(TEXT_ENTRY_SELECTOR)
}

/**
 * Reveals a focused control only when native browser panning has left it near
 * an edge of the visual viewport. `scrollIntoView` handles whichever nested
 * page or sheet owns the control without hard-coding feature selectors here.
 */
export function revealFocusedTextControl(
  control: HTMLElement,
  target: Window = window,
): void {
  const scrollIntoView = control.scrollIntoView
  if (typeof scrollIntoView !== 'function') return

  const viewport = target.visualViewport
  const viewportTop = nonNegativeDimension(viewport?.offsetTop)
    ? viewport.offsetTop
    : 0
  const viewportHeight = positiveDimension(viewport?.height)
    ? viewport.height
    : positiveDimension(target.innerHeight)
      ? target.innerHeight
      : 1
  const viewportBottom = viewportTop + viewportHeight
  const edgeClearance = Math.min(24, viewportHeight * 0.08)
  const controlRect = control.getBoundingClientRect()

  if (
    controlRect.top >= viewportTop + edgeClearance &&
    controlRect.bottom <= viewportBottom - edgeClearance
  ) {
    return
  }

  scrollIntoView.call(control, {
    behavior: 'auto',
    block: 'center',
    inline: 'nearest',
  })
}

/**
 * Keeps the app shell synchronized with browser resize, rotation, keyboard,
 * and visual-viewport scroll events until the returned cleanup runs.
 */
export function installAppViewportGeometrySync(
  element: HTMLElement,
  target: Window = window,
): () => void {
  const root = target.document
  const viewport = target.visualViewport
  let revealFrame = 0
  let revealTimers: number[] = []
  let focusOutTimer = 0

  /** Cancels stale work when focus moves between controls quickly. */
  const cancelScheduledReveal = () => {
    target.cancelAnimationFrame(revealFrame)
    revealFrame = 0
    revealTimers.forEach((timer) => target.clearTimeout(timer))
    revealTimers = []
  }

  /**
   * Rechecks after both browser layout and the native keyboard animation. The
   * later passes matter on iOS, where focus arrives before VisualViewport has
   * reached its final height.
   */
  const scheduleFocusedControlReveal = () => {
    cancelScheduledReveal()
    const reveal = () => {
      const activeElement = root.activeElement
      if (!isTextEntryControl(activeElement)) return
      revealFocusedTextControl(activeElement, target)
    }

    revealFrame = target.requestAnimationFrame(reveal)
    revealTimers = REVEAL_SETTLE_DELAYS.map((delay) =>
      target.setTimeout(reveal, delay),
    )
  }

  /** Synchronizes geometry before deciding whether focused content moved. */
  const synchronize = () => {
    synchronizeAppViewportGeometry(element, target)
    if (element.dataset.textEntryActive === 'true') {
      scheduleFocusedControlReveal()
    }
  }

  /** Marks the app as editing immediately, before keyboard resize begins. */
  const handleFocusIn = (event: FocusEvent) => {
    if (!isTextEntryControl(event.target)) return
    target.clearTimeout(focusOutTimer)
    focusOutTimer = 0
    element.dataset.textEntryActive = 'true'
    synchronize()
  }

  /** Keeps edit mode active when focus moves directly to another field. */
  const handleFocusOut = () => {
    target.clearTimeout(focusOutTimer)
    focusOutTimer = target.setTimeout(() => {
      focusOutTimer = 0
      if (isTextEntryControl(root.activeElement)) return
      delete element.dataset.textEntryActive
      cancelScheduledReveal()
      synchronizeAppViewportGeometry(element, target)
    })
  }

  target.addEventListener('resize', synchronize)
  target.addEventListener('orientationchange', synchronize)
  viewport?.addEventListener('resize', synchronize)
  viewport?.addEventListener('scroll', synchronize)
  root.addEventListener('focusin', handleFocusIn)
  root.addEventListener('focusout', handleFocusOut)
  synchronize()

  return () => {
    cancelScheduledReveal()
    target.clearTimeout(focusOutTimer)
    target.removeEventListener('resize', synchronize)
    target.removeEventListener('orientationchange', synchronize)
    viewport?.removeEventListener('resize', synchronize)
    viewport?.removeEventListener('scroll', synchronize)
    root.removeEventListener('focusin', handleFocusIn)
    root.removeEventListener('focusout', handleFocusOut)
    element.style.removeProperty('--app-visual-viewport-height')
    element.style.removeProperty('--app-visual-viewport-offset-top')
    delete element.dataset.keyboardOpen
    delete element.dataset.textEntryActive
  }
}

/** Releases keyboard-producing focus before a route changes dimensions. */
export function blurActiveTextControl(root: Document = document): void {
  const activeElement = root.activeElement
  if (!isTextEntryControl(activeElement)) return
  activeElement.blur()
}
