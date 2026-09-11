import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  blurActiveTextControl,
  installAppViewportGeometrySync,
  isTextEntryControl,
  readAppViewportGeometry,
  revealFocusedTextControl,
  synchronizeAppViewportGeometry,
} from './appViewportGeometry'

const originalVisualViewport = Object.getOwnPropertyDescriptor(
  window,
  'visualViewport',
)
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
const originalTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')

function restoreDescriptor(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(target, property, descriptor)
  else Reflect.deleteProperty(target, property)
}

function installVisualViewport(input: {
  height: number
  offsetTop?: number
  scale?: number
}) {
  const viewport = Object.assign(new EventTarget(), {
    height: input.height,
    offsetTop: input.offsetTop ?? 0,
    scale: input.scale ?? 1,
  }) as unknown as VisualViewport
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  })
  return viewport
}

function setLayoutHeight(height: number) {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: height,
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  restoreDescriptor(window, 'visualViewport', originalVisualViewport)
  restoreDescriptor(window, 'innerHeight', originalInnerHeight)
  restoreDescriptor(window, 'innerWidth', originalInnerWidth)
  restoreDescriptor(navigator, 'maxTouchPoints', originalTouchPoints)
  document.body.replaceChildren()
})

describe('app viewport geometry', () => {
  it('shrinks the shell to the keyboard-adjusted viewport and restores it', () => {
    setLayoutHeight(844)
    const visualViewport = installVisualViewport({ height: 844 })
    const shell = document.createElement('div')
    const uninstall = installAppViewportGeometrySync(shell)

    expect(shell.style.getPropertyValue('--app-visual-viewport-height')).toBe('844px')
    expect(shell).toHaveAttribute('data-keyboard-open', 'false')

    Object.assign(visualViewport, { height: 402 })
    visualViewport.dispatchEvent(new Event('resize'))
    expect(shell.style.getPropertyValue('--app-visual-viewport-height')).toBe('402px')
    expect(shell).toHaveAttribute('data-keyboard-open', 'true')

    Object.assign(visualViewport, { height: 844 })
    visualViewport.dispatchEvent(new Event('resize'))
    expect(shell.style.getPropertyValue('--app-visual-viewport-height')).toBe('844px')
    expect(shell).toHaveAttribute('data-keyboard-open', 'false')

    uninstall()
    expect(shell.style.getPropertyValue('--app-visual-viewport-height')).toBe('')
    expect(shell).not.toHaveAttribute('data-keyboard-open')
  })

  it('does not confuse accessibility pinch zoom with an open keyboard', () => {
    setLayoutHeight(844)
    installVisualViewport({ height: 422, offsetTop: 32, scale: 2 })

    expect(readAppViewportGeometry()).toEqual({
      height: 844,
      offsetTop: 0,
      keyboardOpen: false,
    })
  })

  it('recognizes keyboard and picker controls without intercepting passive inputs', () => {
    const text = document.createElement('input')
    const date = document.createElement('input')
    const checkbox = document.createElement('input')
    const file = document.createElement('input')
    const range = document.createElement('input')
    const editor = document.createElement('div')
    date.type = 'date'
    checkbox.type = 'checkbox'
    file.type = 'file'
    range.type = 'range'
    editor.setAttribute('contenteditable', 'true')

    expect(isTextEntryControl(text)).toBe(true)
    expect(isTextEntryControl(date)).toBe(true)
    expect(isTextEntryControl(editor)).toBe(true)
    expect(isTextEntryControl(checkbox)).toBe(false)
    expect(isTextEntryControl(file)).toBe(false)
    expect(isTextEntryControl(range)).toBe(false)
  })

  it('reveals an obscured field but leaves a visible field still', () => {
    setLayoutHeight(844)
    installVisualViewport({ height: 402 })
    const input = document.createElement('input')
    const scrollIntoView = vi.fn()
    input.scrollIntoView = scrollIntoView
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
      top: 520,
      bottom: 564,
    } as DOMRect)

    revealFocusedTextControl(input)
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    })

    scrollIntoView.mockClear()
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
      top: 120,
      bottom: 164,
    } as DOMRect)
    revealFocusedTextControl(input)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('tracks text-entry focus and rechecks visibility after keyboard resize', () => {
    vi.useFakeTimers()
    setLayoutHeight(844)
    const visualViewport = installVisualViewport({ height: 844 })
    const shell = document.createElement('div')
    const input = document.createElement('input')
    const file = document.createElement('input')
    const scrollIntoView = vi.fn()
    file.type = 'file'
    input.scrollIntoView = scrollIntoView
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
      top: 640,
      bottom: 684,
    } as DOMRect)
    document.body.append(shell, input, file)
    const uninstall = installAppViewportGeometrySync(shell)

    file.focus()
    expect(shell).not.toHaveAttribute('data-text-entry-active')

    input.focus()
    expect(shell).toHaveAttribute('data-text-entry-active', 'true')

    Object.assign(visualViewport, { height: 402 })
    visualViewport.dispatchEvent(new Event('resize'))
    vi.runAllTimers()
    expect(shell).toHaveAttribute('data-keyboard-open', 'true')
    expect(scrollIntoView).toHaveBeenCalled()

    input.blur()
    vi.runAllTimers()
    expect(shell).not.toHaveAttribute('data-text-entry-active')

    uninstall()
  })

  it('blurs a focused text control while leaving ordinary controls alone', () => {
    const input = document.createElement('input')
    const button = document.createElement('button')
    document.body.append(input, button)

    input.focus()
    expect(document.activeElement).toBe(input)
    blurActiveTextControl()
    expect(document.activeElement).not.toBe(input)

    button.focus()
    blurActiveTextControl()
    expect(document.activeElement).toBe(button)
  })

  it('detects Android when both viewports shrink and keeps route resyncs consistent', () => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    setLayoutHeight(844)
    const viewport = installVisualViewport({ height: 844 })
    const shell = document.createElement('div')
    const input = document.createElement('input')
    document.body.append(shell, input)
    const uninstall = installAppViewportGeometrySync(shell)
    input.focus()
    setLayoutHeight(444)
    Object.assign(viewport, { height: 444 })
    viewport.dispatchEvent(new Event('resize'))
    expect(shell.dataset.keyboardOpen).toBe('true')
    expect(shell.style.getPropertyValue('--app-visual-viewport-height')).toBe('444px')
    synchronizeAppViewportGeometry(shell)
    expect(shell.dataset.keyboardOpen).toBe('true')

    // Rotation, dismissal and reopening while the same field remains focused.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 844 })
    setLayoutHeight(230)
    Object.assign(viewport, { height: 230 })
    window.dispatchEvent(new Event('resize'))
    expect(shell.dataset.keyboardOpen).toBe('true')
    setLayoutHeight(390)
    Object.assign(viewport, { height: 390 })
    window.dispatchEvent(new Event('resize'))
    expect(shell.dataset.keyboardOpen).toBe('false')
    setLayoutHeight(230)
    Object.assign(viewport, { height: 230 })
    window.dispatchEvent(new Event('resize'))
    expect(shell.dataset.keyboardOpen).toBe('true')
    uninstall()
  })

  it('moves a low but uncovered field into a comfortable band only during keyboard entry', () => {
    setLayoutHeight(844)
    installVisualViewport({ height: 402 })
    const input = document.createElement('input')
    input.scrollIntoView = vi.fn()
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ top: 315, bottom: 359 } as DOMRect)
    revealFocusedTextControl(input)
    expect(input.scrollIntoView).not.toHaveBeenCalled()
    revealFocusedTextControl(input, window, { keyboardOpen: true })
    expect(input.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  })

  it('respects reduced motion and does not pan a pinch-zoomed page', () => {
    setLayoutHeight(844)
    const viewport = installVisualViewport({ height: 402 })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const input = document.createElement('input')
    input.scrollIntoView = vi.fn()
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ top: 500, bottom: 544 } as DOMRect)
    revealFocusedTextControl(input)
    expect(input.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'instant' }))
    vi.mocked(input.scrollIntoView).mockClear()
    Object.assign(viewport, { scale: 2 })
    revealFocusedTextControl(input)
    expect(input.scrollIntoView).not.toHaveBeenCalled()
  })

  it('gives the final field scroll room inside its sheet and restores original inline padding', () => {
    vi.useFakeTimers()
    setLayoutHeight(844)
    installVisualViewport({ height: 402 })
    const shell = document.createElement('div')
    const sheet = document.createElement('div')
    sheet.style.overflowY = 'auto'
    sheet.style.setProperty('padding-bottom', '12px', 'important')
    Object.defineProperties(sheet, {
      clientHeight: { value: 350 }, scrollHeight: { value: 500 }, scrollTop: { value: 100, writable: true },
    })
    sheet.scrollTo = vi.fn()
    vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue({ top: 20, bottom: 370 } as DOMRect)
    const input = document.createElement('input')
    input.scrollIntoView = vi.fn()
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ top: 330, bottom: 374 } as DOMRect)
    sheet.append(input)
    shell.append(sheet)
    document.body.append(shell)
    const uninstall = installAppViewportGeometrySync(shell)
    input.focus()
    vi.runAllTimers()
    expect(sheet.scrollTo).toHaveBeenCalledWith({ top: expect.any(Number), behavior: 'smooth' })
    expect(vi.mocked(sheet.scrollTo).mock.calls[0][0]).toMatchObject({ top: expect.closeTo(281.48) })
    expect(Number.parseFloat(sheet.style.paddingBottom)).toBeCloseTo(143.48)
    expect(input.scrollIntoView).not.toHaveBeenCalled()
    input.blur()
    // Let the submit-button tap complete before removing temporary scroll room.
    vi.advanceTimersByTime(100)
    expect(sheet.style.paddingBottom).not.toBe('12px')
    vi.runAllTimers()
    expect(sheet.style.paddingBottom).toBe('12px')
    expect(sheet.style.getPropertyPriority('padding-bottom')).toBe('important')
    uninstall()
  })

  it('debounces animation frames and never recenters in response to viewport scrolling', () => {
    vi.useFakeTimers()
    setLayoutHeight(844)
    const viewport = installVisualViewport({ height: 402 })
    const shell = document.createElement('div')
    const input = document.createElement('input')
    input.scrollIntoView = vi.fn()
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ top: 500, bottom: 544 } as DOMRect)
    document.body.append(shell, input)
    const uninstall = installAppViewportGeometrySync(shell)
    input.focus()
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(30)
      viewport.dispatchEvent(new Event('resize'))
    }
    expect(input.scrollIntoView).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(input.scrollIntoView).toHaveBeenCalledTimes(1)
    viewport.dispatchEvent(new Event('scroll'))
    vi.runAllTimers()
    expect(input.scrollIntoView).toHaveBeenCalledTimes(1)
    viewport.dispatchEvent(new Event('resize'))
    document.dispatchEvent(new Event('touchstart'))
    vi.runAllTimers()
    expect(input.scrollIntoView).toHaveBeenCalledTimes(1)
    uninstall()
  })

  it('does not treat readonly and disabled fields as keyboard entry', () => {
    const input = document.createElement('input')
    input.readOnly = true
    expect(isTextEntryControl(input)).toBe(false)
    input.readOnly = false
    input.disabled = true
    expect(isTextEntryControl(input)).toBe(false)
  })
})
