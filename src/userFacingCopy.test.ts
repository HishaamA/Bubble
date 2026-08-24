import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const emDash = String.fromCodePoint(0x2014)
const forbiddenCopy = [
  emDash,
  '&' + 'mdash;',
  '&#' + '8212;',
  '&#x' + '2014;',
  '\\' + 'u2014',
  '\\' + 'U00002014',
]

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

function includesForbiddenCopy(value: string) {
  const normalized = value.toLowerCase()
  return forbiddenCopy.some((token) => normalized.includes(token.toLowerCase()))
}

describe('user-facing punctuation', () => {
  it('does not ship em dashes in authored app copy', () => {
    const projectRoot = process.cwd()
    const violations: string[] = []
    const sourceFiles = filesUnder(join(projectRoot, 'src')).filter(
      (path) =>
        /\.tsx?$/.test(path) &&
        !/\.(?:test|spec)\.tsx?$/.test(path),
    )

    for (const path of sourceFiles) {
      const sourceText = readFileSync(path, 'utf8')
      const sourceFile = ts.createSourceFile(
        path,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        extname(path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      )

      const inspectNode = (node: ts.Node) => {
        const isCopyNode =
          ts.isStringLiteralLike(node) ||
          ts.isJsxText(node) ||
          node.kind === ts.SyntaxKind.TemplateHead ||
          node.kind === ts.SyntaxKind.TemplateMiddle ||
          node.kind === ts.SyntaxKind.TemplateTail

        if (isCopyNode && includesForbiddenCopy(node.getText(sourceFile))) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          )
          violations.push(`${relative(projectRoot, path)}:${line + 1}`)
        }

        ts.forEachChild(node, inspectNode)
      }

      inspectNode(sourceFile)
    }

    const indexHtml = readFileSync(join(projectRoot, 'index.html'), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      '',
    )
    if (includesForbiddenCopy(indexHtml)) {
      violations.push('index.html')
    }

    expect(violations, 'Replace em dashes with a comma, colon, or full stop.').toEqual(
      [],
    )
  })
})
