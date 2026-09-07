import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  blurActiveTextControl,
  installAppViewportGeometrySync,
  isTextEntryControl,
  readAppViewportGeometry,
  revealFocusedTextControl,
} from './appViewportGeometry'

const originalVisualViewport = Object.getOwnPropertyDescriptor(
  window,
  'visualViewport',
)
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

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
  restoreDescriptor(window, 'visualViewport', originalVisualViewport)
  restoreDescriptor(window, 'innerHeight', originalInnerHeight)
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
      behavior: 'auto',
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
})
