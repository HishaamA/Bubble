export type AppViewportGeometry = {
  height: number
  offsetTop: number
  keyboardOpen: boolean
}

const KEYBOARD_MINIMUM_DIFFERENCE = 120
const KEYBOARD_MINIMUM_RATIO = 0.16
const UNZOOMED_SCALE_TOLERANCE = 1.05
const REVEAL_SETTLE_DELAY = 160
const viewportCoordinators = new WeakMap<HTMLElement, { target: Window; synchronize: () => void }>()
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
  restingHeight?: number,
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
    Math.max(layoutHeight, restingHeight ?? 0) - visualHeight - visualOffsetTop,
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
  const coordinator = viewportCoordinators.get(element)
  if (coordinator?.target === target) {
    coordinator.synchronize()
    return
  }
  applyAppViewportGeometry(element, readAppViewportGeometry(target))
}

/** Returns whether an element can summon a keyboard or native input picker. */
export function isTextEntryControl(
  value: EventTarget | null,
): value is HTMLElement {
  return value instanceof HTMLElement && value.matches(TEXT_ENTRY_SELECTOR) &&
    !value.matches(':disabled, [readonly]')
}

/**
 * Scrolls the owning page/sheet, not the entire fixed app shell. A keyboard-
 * adjusted comfort band keeps low fields away from the keys without moving
 * fields already at a comfortable reading height.
 */
export function revealFocusedTextControl(
  control: HTMLElement,
  target: Window = window,
  options: {
    keyboardOpen?: boolean
    reserveSpace?: (region: HTMLElement, extra: number) => void
  } = {},
): void {
  const viewport = target.visualViewport
  if ((viewport?.scale ?? 1) > UNZOOMED_SCALE_TOLERANCE) return
  const viewportTop = nonNegativeDimension(viewport?.offsetTop)
    ? viewport.offsetTop
    : 0
  const viewportHeight = positiveDimension(viewport?.height)
    ? viewport.height
    : positiveDimension(target.innerHeight)
      ? target.innerHeight
      : 1
  let viewportBottom = viewportTop + viewportHeight
  let visibleTop = viewportTop
  let region = control.parentElement
  while (region && region !== target.document.body) {
    if (/(auto|scroll|overlay)/.test(target.getComputedStyle(region).overflowY) && region.clientHeight > 0) {
      const rect = region.getBoundingClientRect()
      visibleTop = Math.max(visibleTop, rect.top)
      viewportBottom = Math.min(viewportBottom, rect.top + region.clientTop + region.clientHeight)
      break
    }
    region = region.parentElement
  }
  if (region === target.document.body) region = null
  const visibleHeight = viewportBottom - visibleTop
  if (visibleHeight <= 0) return
  const edgeClearance = Math.min(24, viewportHeight * 0.08)
  const controlRect = control.getBoundingClientRect()
  const controlHeight = controlRect.bottom - controlRect.top
  const comfortableBottom = options.keyboardOpen
    ? visibleTop + Math.max(visibleHeight * 0.72, Math.min(controlHeight + edgeClearance * 2, visibleHeight))
    : viewportBottom - edgeClearance

  if (
    controlRect.top >= visibleTop + edgeClearance &&
    controlRect.bottom <= comfortableBottom
  ) {
    return
  }

  const behavior = target.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 'instant' : 'smooth'
  if (region && typeof region.scrollTo === 'function') {
    // Tall editors align their top rather than hiding the first lines above the sheet.
    const desiredTop = visibleTop + Math.max(edgeClearance, (visibleHeight - controlHeight) * 0.42)
    const delta = controlRect.top - desiredTop
    const remaining = region.scrollHeight - region.clientHeight - region.scrollTop
    if (options.keyboardOpen && delta > remaining) {
      options.reserveSpace?.(region, Math.min(visibleHeight * 0.5, delta - remaining))
    }
    region.scrollTo({ top: Math.max(0, region.scrollTop + delta), behavior })
    return
  }
  control.scrollIntoView?.({
    behavior,
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
  let revealTimer = 0
  let focusOutTimer = 0
  let restingHeight = target.innerHeight
  let restingWidth = target.innerWidth
  let keyboardWasOpen = false
  const reservedRegions = new Map<HTMLElement, { value: string; priority: string; base: number; extra: number }>()

  const clearReservedSpace = () => {
    reservedRegions.forEach(({ value, priority }, region) => {
      if (value) region.style.setProperty('padding-bottom', value, priority)
      else region.style.removeProperty('padding-bottom')
    })
    reservedRegions.clear()
  }

  const reserveSpace = (region: HTMLElement, extra: number) => {
    const reserved = reservedRegions.get(region) ?? {
      value: region.style.getPropertyValue('padding-bottom'),
      priority: region.style.getPropertyPriority('padding-bottom'),
      base: Number.parseFloat(target.getComputedStyle(region).paddingBottom) || 0,
      extra: 0,
    }
    reserved.extra = Math.min((target.visualViewport?.height ?? target.innerHeight) * 0.5, reserved.extra + extra)
    reservedRegions.set(region, reserved)
    region.style.setProperty('padding-bottom', `${reserved.base + reserved.extra}px`, 'important')
  }

  /** Cancels stale work when focus moves between controls quickly. */
  const cancelScheduledReveal = () => {
    target.cancelAnimationFrame(revealFrame)
    revealFrame = 0
    target.clearTimeout(revealTimer)
    revealTimer = 0
  }

  /**
   * Waits for keyboard resize events to settle, then makes one smooth move.
   * Scrolling itself must not restart that animation or fight a user's drag.
   */
  const scheduleFocusedControlReveal = () => {
    cancelScheduledReveal()
    const reveal = () => {
      const activeElement = root.activeElement
      if (!isTextEntryControl(activeElement)) return
      revealFocusedTextControl(activeElement, target, {
        keyboardOpen: element.dataset.keyboardOpen === 'true', reserveSpace,
      })
    }

    revealTimer = target.setTimeout(() => {
      revealTimer = 0
      revealFrame = target.requestAnimationFrame(reveal)
    }, REVEAL_SETTLE_DELAY)
  }

  /** Synchronizes geometry before deciding whether focused content moved. */
  const synchronize = () => {
    const widthChanged = Math.abs(target.innerWidth - restingWidth) > 80
    if (widthChanged) {
      // A quarter-turn swaps the resting axes, not the keyboard-shortened
      // height. Learn other resize shapes afresh (e.g. split-screen windows).
      const rotated = Math.abs(target.innerWidth - restingHeight) <= Math.max(80, restingHeight * 0.15)
      restingHeight = rotated ? Math.max(target.innerHeight, restingWidth) : target.innerHeight
      restingWidth = target.innerWidth
      clearReservedSpace()
    }
    const editing = isTextEntryControl(root.activeElement)
    const touchDevice = target.navigator.maxTouchPoints > 0 ||
      target.matchMedia?.('(pointer: coarse)').matches
    const geometry = readAppViewportGeometry(target,
      touchDevice && (editing || keyboardWasOpen) ? restingHeight : undefined)
    applyAppViewportGeometry(element, geometry)
    if (!geometry.keyboardOpen) {
      clearReservedSpace()
      restingHeight = editing ? Math.max(restingHeight, target.innerHeight) : target.innerHeight
    }
    keyboardWasOpen = geometry.keyboardOpen
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
    clearReservedSpace()
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
      clearReservedSpace()
      synchronize()
    }, 250)
  }

  target.addEventListener('resize', synchronize)
  target.addEventListener('orientationchange', synchronize)
  viewport?.addEventListener('resize', synchronize)
  // Safari may pan its visual viewport during focus. Update the shell position
  // without repeatedly centering the field throughout our smooth scroll.
  const synchronizeOffset = () => {
    const geometry = readAppViewportGeometry(target)
    element.style.setProperty('--app-visual-viewport-offset-top', `${geometry.offsetTop}px`)
  }
  viewport?.addEventListener('scroll', synchronizeOffset)
  root.addEventListener('touchstart', cancelScheduledReveal, { passive: true })
  root.addEventListener('wheel', cancelScheduledReveal, { passive: true })
  root.addEventListener('focusin', handleFocusIn)
  root.addEventListener('focusout', handleFocusOut)
  viewportCoordinators.set(element, { target, synchronize })
  synchronize()

  return () => {
    cancelScheduledReveal()
    target.clearTimeout(focusOutTimer)
    clearReservedSpace()
    target.removeEventListener('resize', synchronize)
    target.removeEventListener('orientationchange', synchronize)
    viewport?.removeEventListener('resize', synchronize)
    viewport?.removeEventListener('scroll', synchronizeOffset)
    root.removeEventListener('touchstart', cancelScheduledReveal)
    root.removeEventListener('wheel', cancelScheduledReveal)
    root.removeEventListener('focusin', handleFocusIn)
    root.removeEventListener('focusout', handleFocusOut)
    if (viewportCoordinators.get(element)?.synchronize === synchronize) viewportCoordinators.delete(element)
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
