import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppWhimsy, type AppWhimsyPage } from './AppWhimsy'

const whimsyStyles = readFileSync(
  join(process.cwd(), 'src/app/AppWhimsy.css'),
  'utf8',
)

const pageVariants = {
  moments: true,
  capsule: true,
  journal: true,
  settings: true,
} satisfies Record<AppWhimsyPage, true>

const pages = Object.keys(pageVariants) as AppWhimsyPage[]

const interactiveSelector = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  '[role]',
  '[onclick]',
].join(', ')

function decorationIn(container: HTMLElement) {
  const decoration = container.querySelector<HTMLElement>('[data-app-whimsy]')

  expect(decoration).not.toBeNull()
  return decoration as HTMLElement
}

function placementSignature(decoration: HTMLElement) {
  return Array.from(decoration.children, (piece) => ({
    element: piece.tagName.toLowerCase(),
    hook: piece.getAttribute('class'),
  }))
}

describe('AppWhimsy', () => {
  it('is exposed only as presentation and never as an interaction target', () => {
    const { container } = render(<AppWhimsy page="journal" />)
    const decoration = decorationIn(container)
    const svgs = decoration.querySelectorAll('svg')

    expect(decoration).toHaveAttribute('aria-hidden', 'true')
    expect(decoration.matches(interactiveSelector)).toBe(false)
    expect(decoration.querySelectorAll(interactiveSelector)).toHaveLength(0)
    expect(svgs.length).toBeGreaterThan(0)
    for (const svg of svgs) {
      expect(svg).toHaveAttribute('focusable', 'false')
    }
  })

  it.each(pages)(
    'publishes stable stylesheet placement hooks for the %s page',
    (page) => {
      const firstRender = render(<AppWhimsy page={page} />)
      const firstDecoration = decorationIn(firstRender.container)
      const firstSignature = placementSignature(firstDecoration)

      expect(firstDecoration).toHaveAttribute('data-whimsy-page', page)
      expect(firstDecoration).toHaveClass('app-whimsy', `app-whimsy--${page}`)
      expect(firstDecoration.querySelectorAll('[style]')).toHaveLength(0)
      expect(firstSignature.length).toBeGreaterThan(0)
      expect(firstSignature.every(({ hook }) => Boolean(hook))).toBe(true)
      expect(new Set(firstSignature.map(({ hook }) => hook)).size).toBe(
        firstSignature.length,
      )
      expect(whimsyStyles).toContain(`.app-whimsy--${page}`)

      firstRender.unmount()
      const secondRender = render(<AppWhimsy page={page} />)
      expect(placementSignature(decorationIn(secondRender.container))).toEqual(
        firstSignature,
      )
    },
  )

  it('keeps the entire decorative layer out of pointer hit testing', () => {
    expect(whimsyStyles).toMatch(
      /\.app-whimsy\s*,\s*\.app-whimsy \*\s*\{[^}]*pointer-events:\s*none\s*;/s,
    )
  })

  it('moves decorative pieces through stylesheet animation', () => {
    const keyframes = whimsyStyles.slice(whimsyStyles.indexOf('@keyframes'))

    expect(whimsyStyles).toMatch(/animation:\s*app-whimsy-[\w-]+/)
    expect(keyframes).toMatch(/\b(?:transform|translate):/)
  })

  it('keeps the moving composition inside real whitespace instead of clipping edges', () => {
    expect(whimsyStyles).not.toMatch(/\b(?:left|right):\s*-\d/)
    expect(whimsyStyles).toContain(':has(.people-timeline__albums-empty)')
    expect(whimsyStyles).toContain(".journal-page[data-section='plans']")
    expect(whimsyStyles).toContain(".journal-page[data-section='flights']")
    expect(whimsyStyles).toContain('.app-whimsy--moments > *')
    expect(whimsyStyles).toContain('.app-whimsy--settings > *')
  })

  it('disables every decorative animation when reduced motion is requested', () => {
    const reducedMotionContract = whimsyStyles.match(
      /@media \(prefers-reduced-motion:\s*reduce\)\s*\{\s*([^{}]+)\{[^{}]*animation:\s*none\s*;?[^{}]*\}\s*\}/s,
    )

    expect(reducedMotionContract).not.toBeNull()
    for (const selector of ['cloud', 'trail', 'spark', 'bubble']) {
      expect(reducedMotionContract?.[1]).toContain(`.app-whimsy__${selector}`)
    }
  })
})
