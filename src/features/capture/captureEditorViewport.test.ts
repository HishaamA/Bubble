import { afterEach, describe, expect, it } from 'vitest'
import {
  installCaptureEditorViewportSync,
  readCaptureEditorViewport,
} from './captureEditorViewport'

const originalVisualViewportDescriptor = Object.getOwnPropertyDescriptor(
  window,
  'visualViewport',
)

afterEach(() => {
  if (originalVisualViewportDescriptor) {
    Object.defineProperty(
      window,
      'visualViewport',
      originalVisualViewportDescriptor,
    )
  } else {
    Reflect.deleteProperty(window, 'visualViewport')
  }
})

function installVisualViewport(height: number) {
  const viewport = Object.assign(new EventTarget(), {
    height,
  }) as unknown as VisualViewport
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  })
  return viewport
}

describe('capture editor viewport', () => {
  it('uses the keyboard-adjusted visual viewport when available', () => {
    installVisualViewport(402)

    expect(readCaptureEditorViewport()).toEqual({
      height: 402,
    })
  })

  it('falls back to the layout viewport without the Visual Viewport API', () => {
    Reflect.deleteProperty(window, 'visualViewport')

    expect(readCaptureEditorViewport()).toEqual({
      height: window.innerHeight,
    })
  })

  it('resizes only the mounted capture editor and restores it on cleanup', () => {
    const viewport = installVisualViewport(844)
    const editor = document.createElement('section')
    const uninstall = installCaptureEditorViewportSync(editor)

    expect(editor.style.getPropertyValue('--capture-editor-viewport-height'))
      .toBe('844px')
    expect(editor).toHaveAttribute('data-compact-editor', 'false')

    Object.assign(viewport, { height: 402 })
    viewport.dispatchEvent(new Event('resize'))

    expect(editor.style.getPropertyValue('--capture-editor-viewport-height'))
      .toBe('402px')
    expect(editor).toHaveAttribute('data-compact-editor', 'true')

    Object.assign(viewport, { height: 844 })
    viewport.dispatchEvent(new Event('resize'))
    expect(editor.style.getPropertyValue('--capture-editor-viewport-height'))
      .toBe('844px')
    expect(editor).toHaveAttribute('data-compact-editor', 'false')

    uninstall()
    expect(editor.style.getPropertyValue('--capture-editor-viewport-height'))
      .toBe('')
    expect(editor).not.toHaveAttribute('data-compact-editor')

    Object.assign(viewport, { height: 300 })
    viewport.dispatchEvent(new Event('resize'))
    expect(editor.style.getPropertyValue('--capture-editor-viewport-height'))
      .toBe('')
  })
})
