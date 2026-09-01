import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const sourceRoot = path.resolve('src')
const nativeClickTargets = new Set([
  'div',
  'figure',
  'img',
  'li',
  'p',
  'section',
  'span',
])

// These controls are intentionally exercised through the owning screen. Keep
// the exception list explicit so moving a control into a new file also forces
// a decision about where its behavior belongs in the test suite.
const integrationCoverage = new Map([
  ['src/features/auth/EmailCodeAuthFlow.tsx', 'src/features/auth/AuthPage.test.tsx'],
  ['src/features/capture/Capture360Shortcut.tsx', 'src/app/AppShell.test.tsx'],
  ['src/features/events/JournalEventsSection.tsx', 'src/features/events/EventsPage.test.tsx'],
  ['src/features/memories/MemoryBubble.tsx', 'src/features/memories/MemoryConstellation.test.tsx'],
  ['src/features/memories/SharedMomentBubble.tsx', 'src/features/memories/MemoryConstellation.test.tsx'],
])

type ControlFinding = {
  file: string
  line: number
  reason: string
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(fullPath)
    if (!entry.name.endsWith('.tsx') || entry.name.endsWith('.test.tsx')) return []
    return [fullPath]
  })
}

function attributeNames(opening: ts.JsxOpeningLikeElement, sourceFile: ts.SourceFile) {
  return new Set(opening.attributes.properties.flatMap((attribute) => (
    ts.isJsxAttribute(attribute) ? [attribute.name.getText(sourceFile)] : []
  )))
}

function hasRenderedContent(node: ts.JsxElement, sourceFile: ts.SourceFile): boolean {
  return node.children.some((child) => {
    if (ts.isJsxText(child)) return child.getText(sourceFile).trim().length > 0
    if (ts.isJsxExpression(child)) return child.expression !== undefined
    if (ts.isJsxElement(child)) return hasRenderedContent(child, sourceFile)
    if (ts.isJsxSelfClosingElement(child)) return true
    if (ts.isJsxFragment(child)) {
      return child.children.some((fragmentChild) => (
        ts.isJsxText(fragmentChild)
          ? fragmentChild.getText(sourceFile).trim().length > 0
          : true
      ))
    }
    return false
  })
}

function referenceFor(sourceFile: ts.SourceFile, node: ts.Node): Omit<ControlFinding, 'reason'> {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    file: path.relative(process.cwd(), sourceFile.fileName),
    line: location.line + 1,
  }
}

/**
 * This is a markup contract, not a replacement for behavioral tests. It scans
 * every production TSX file so a newly added control cannot quietly become an
 * accidental form submit, an unnamed icon button, or a mouse-only click area.
 */
function auditInteractiveMarkup() {
  const findings: ControlFinding[] = []
  let buttonCount = 0
  const controlFiles = new Set<string>()

  for (const file of sourceFiles(sourceRoot)) {
    const source = fs.readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )

    function visit(node: ts.Node) {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node
        const tag = opening.tagName.getText(sourceFile)
        const attributes = attributeNames(opening, sourceFile)
        const reference = referenceFor(sourceFile, opening)

        if (tag === 'button') {
          buttonCount += 1
          controlFiles.add(path.relative(process.cwd(), file))
          if (!attributes.has('type')) {
            findings.push({ ...reference, reason: 'native button has no explicit type' })
          }

          const accessibleName = attributes.has('aria-label')
            || attributes.has('aria-labelledby')
            || attributes.has('title')
            || (ts.isJsxElement(node) && hasRenderedContent(node, sourceFile))
          if (!accessibleName) {
            findings.push({ ...reference, reason: 'button has no accessible name' })
          }
        }

        // A native button already supplies keyboard behavior and semantics.
        // If a plain visual element is clickable, it must provide both itself.
        if (nativeClickTargets.has(tag) && attributes.has('onClick')) {
          const hasKeyboardHandler = attributes.has('onKeyDown') || attributes.has('onKeyUp')
          const hasButtonSemantics = attributes.has('role') && attributes.has('tabIndex')
          if (!hasKeyboardHandler || !hasButtonSemantics) {
            findings.push({
              ...reference,
              reason: 'non-button click target lacks keyboard/button semantics',
            })
          }
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return { buttonCount, controlFiles: [...controlFiles].sort(), findings }
}

function directTestFor(componentFile: string) {
  return componentFile.replace(/\.tsx$/, '.test.tsx')
}

describe('interactive control markup', () => {
  it('keeps every native button explicit, named, and keyboard-safe', () => {
    const audit = auditInteractiveMarkup()

    // This lower bound makes a broken scanner fail loudly instead of reporting
    // a suspiciously perfect empty result.
    expect(audit.buttonCount).toBeGreaterThan(150)
    expect(audit.findings).toEqual([])
  })

  it('keeps every button-bearing component attached to behavioral coverage', () => {
    const audit = auditInteractiveMarkup()
    const uncovered = audit.controlFiles.filter((componentFile) => {
      const testFile = fs.existsSync(directTestFor(componentFile))
        ? directTestFor(componentFile)
        : integrationCoverage.get(componentFile)
      return !testFile || !fs.existsSync(testFile)
    })

    expect(
      uncovered,
      'Add a sibling behavior test or a deliberate integrationCoverage entry.',
    ).toEqual([])
  })
})
