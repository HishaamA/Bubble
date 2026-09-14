import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const journalCss = readFileSync('src/features/journal/JournalPage.css', 'utf8')
const appCss = readFileSync('src/App.css', 'utf8')
const themeCss = readFileSync('src/theme/AppTheme.css', 'utf8')

function declarations(css: string, selector: string) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(',').some((part) => part.trim() === selector))
    .map((match) => match[2])
    .join('\n')
}

// Browser/device checks verify the motion itself; these guard the positioning
// contract, including responsive overrides, without pretending jsdom scrolls.
describe('Journal scroll layout', () => {
  it('keeps the heading and tabs in the same natural page scroll at every breakpoint', () => {
    for (const selector of ['.journal-page__chrome', '.journal-page__tabs']) {
      const rule = declarations(journalCss, selector)
      expect(rule).toContain('position: relative')
      expect(rule).not.toMatch(/position:\s*(sticky|fixed|absolute)/)
      expect(rule).not.toMatch(/(?:^|\n)\s*top:/)
    }
    const page = declarations(journalCss, '.journal-page')
    expect(page).toContain('height: 100%')
    expect(page).toContain('overflow-y: auto')
    expect(declarations(journalCss, '.journal-page__panel')).not.toMatch(/overflow(?:-y)?:\s*(auto|scroll)/)
  })

  it('does not move a second opaque theme canvas along with the heading', () => {
    const chrome = declarations(themeCss, ':root[data-bubble-theme] .journal-page__chrome')
    expect(chrome).toContain('background: transparent')
    expect(chrome).toContain('backdrop-filter: none')
    expect(chrome).not.toContain('background: var(--theme-page-background)')
    expect(chrome).not.toContain('radial-gradient')
  })

  it('preserves the independent bottom navigation and its page-end clearance', () => {
    const nav = declarations(appCss, '.tab-bar')
    expect(nav).toContain('position: absolute')
    expect(nav).toContain('bottom: 0')
    expect(appCss).toContain('padding-bottom: calc(var(--bottom-chrome-height) + var(--safe-bottom) + 1rem)')
    const statusBar = declarations(appCss, '.app-status-bar-backdrop')
    expect(statusBar).toContain('pointer-events: none')
    expect(statusBar).toContain('var(--native-safe-area-top, 0px)')
  })
})
