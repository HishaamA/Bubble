import { afterEach, describe, expect, it } from 'vitest'
import {
  blurActiveTextControl,
  installAppViewportGeometrySync,
  readAppViewportGeometry,
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
