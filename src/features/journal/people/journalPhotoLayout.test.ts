import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const timelineCss = readFileSync('src/features/journal/people/PeopleTimeline.css', 'utf8')
const scrapbookCss = readFileSync('src/features/journal/people/PersonScrapbookPage.css', 'utf8')

function declarations(css: string, selector: string) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(',').some((part) => part.trim() === selector))
    .map((match) => match[2])
    .join('\n')
}

// CSS contracts complement real-browser checks in scripts/qa/journal-photo-layout.html.
// jsdom cannot reproduce WebKit's native date field intrinsic sizing.
describe('Journal photo layout contracts', () => {
  it('lets the native date field and its grid shrink within the editor', () => {
    expect(declarations(timelineCss, '.people-timeline__date-editor'))
      .toContain('grid-template-columns: minmax(0, 1fr)')
    const input = declarations(timelineCss, '.people-timeline__date-editor input')
    expect(input).toContain('min-width: 0')
    expect(input).toContain('max-width: 100%')
    expect(input).toContain('box-sizing: border-box')
    expect(input).toContain('font-size: 1rem')
    expect(declarations(timelineCss, ".people-timeline__date-editor input[type='date']::-webkit-date-and-time-value"))
      .toContain('min-width: 0')
  })

  it('uses paper ink for date labels, native values and every action', () => {
    expect(declarations(timelineCss, '.journal-page .people-timeline .people-timeline__date-editor'))
      .toContain('--date-editor-ink: var(--journal-paper-ink')
    expect(declarations(timelineCss, '.journal-page .people-timeline .people-timeline__date-editor label > span'))
      .toContain('color: var(--date-editor-muted)')
    for (const selector of [
      '.journal-page .people-timeline .people-timeline__date-editor input',
      '.journal-page .people-timeline .people-timeline__date-editor .people-timeline__date-kind button',
      '.journal-page .people-timeline .people-timeline__date-editor .people-timeline__form-actions button',
    ]) {
      expect(declarations(timelineCss, selector)).toContain('color: var(--date-editor-ink)')
    }
  })

  it('keeps scrapbook cards out of fragmented columns and captions in normal flow', () => {
    const collage = declarations(scrapbookCss, '.person-scrapbook__collage')
    expect(collage).toContain('display: grid')
    expect(collage).toContain('repeat(2, minmax(0, 1fr))')
    expect(collage).not.toMatch(/(?:^|\n)\s*columns:/)
    expect(declarations(scrapbookCss, '.person-scrapbook__photo figcaption'))
      .not.toContain('position: absolute')
    for (const selector of [
      '.person-scrapbook__photo figcaption strong',
      '.person-scrapbook__photo figcaption time',
      '.person-scrapbook__photo figcaption span',
    ]) {
      const caption = declarations(scrapbookCss, selector)
      expect(caption).toContain('overflow-wrap: anywhere')
      expect(caption).not.toContain('white-space: nowrap')
      expect(caption).not.toContain('text-overflow: ellipsis')
    }
  })
})
