/// <reference types="node" />
import { posix } from 'node:path'
import * as ts from 'typescript'

export const PURE_DOMAIN_MODULES = [
  'src/features/widgets/widgetEventProjection.ts',
  'src/features/capsules/capsuleReconciliation.ts',
  'src/features/journal/people/peopleTimelineSelectors.ts',
  'src/features/events/planViewModel.ts',
  'src/features/flights/flightPresentation.ts',
] as const

export type ArchitectureRule = 'viewer-isolation' | 'service-presentation' | 'pure-domain'

export type ModuleDependency = {
  /** Null means a computed import that cannot be checked statically. */
  specifier: string | null
  /** The entire declaration is erased, not merely its named bindings. */
  typeOnly: boolean
  line: number
}

type ModuleFacts = {
  dependencies: ModuleDependency[]
  hasJsx: boolean
}

/** Lazy readers avoid opening unrelated media/UI source in cloud-backed folders. */
export type ArchitectureSources = ReadonlyMap<string, string | (() => string)>

export type ArchitectureViolation = {
  rule: ArchitectureRule
  importer: string
  line: number
  specifier: string | null
  reason: string
  /** Includes the originating boundary and each runtime dependency on the way. */
  chain: string[]
}

const excludedDirectories = /(?:^|\/)(?:test|tests|__tests__|__mocks__|fixtures|__fixtures__)(?:\/|$)/
const sourceExtension = /\.[cm]?[jt]sx?$/
const nonProductionFile = /(?:\.(?:test|spec|stories)\.[cm]?[jt]sx?|\.d\.[cm]?ts)$/
const stylesheet = /\.(?:css|scss|sass|less|styl)$/
const assetExtension = /\.(?:css|scss|sass|less|styl|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp[34]|wav|webm|glb)$/

export function isExcludedSourcePath(path: string) {
  return excludedDirectories.test(path) || nonProductionFile.test(path)
}

export function isProductionSourcePath(path: string) {
  return path.startsWith('src/') && sourceExtension.test(path) && !isExcludedSourcePath(path)
}

/** Syntax-aware edges: comments, strings, and erased type contracts aren't imports. */
export function inspectModule(path: string, source: string): ModuleFacts {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const dependencies: ModuleDependency[] = []
  let hasJsx = false
  const add = (node: ts.Node, expression: ts.Node | undefined, typeOnly: boolean) => {
    const specifier = expression && ts.isStringLiteralLike(expression) ? expression.text : null
    dependencies.push({
      specifier,
      typeOnly,
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    })
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      // With this project's verbatimModuleSyntax, `import { type T }` still
      // emits `import {}` and loads the module. Only `import type` erases it.
      add(node, node.moduleSpecifier, Boolean(node.importClause?.isTypeOnly))
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node, node.moduleSpecifier, node.isTypeOnly)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, node.isTypeOnly)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal, true)
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )) {
      add(node, node.arguments[0], false)
    }
    if (!hasJsx && (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))) {
      hasJsx = true
      // tsconfig uses react-jsx: even JSX without an explicit React import emits
      // this runtime dependency. It matters when the guarded root itself is UI.
      dependencies.push({
        specifier: 'react/jsx-runtime',
        typeOnly: false,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { dependencies, hasJsx }
}

type ResolvedDependency =
  | { kind: 'source' | 'asset' | 'missing'; path: string }
  | { kind: 'external'; path: string }

/** Mirrors the relative TS/index imports used here, including emitted .js names. */
function resolveDependency(importer: string, specifier: string, modulePaths: ReadonlySet<string>): ResolvedDependency {
  const clean = specifier.split(/[?#]/)[0]
  const local = clean.startsWith('.')
    ? posix.normalize(posix.join(posix.dirname(importer), clean))
    : clean.startsWith('@/') ? `src/${clean.slice(2)}`
      : clean.startsWith('/src/') ? clean.slice(1)
        : null
  if (local === null) return { kind: 'external', path: clean }
  const stem = local.replace(/\.[cm]?jsx?$/, '')
  const candidates = [local, ...[stem, `${local}/index`].flatMap((base) =>
    ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((extension) => base + extension))]
  const resolved = candidates.find((candidate) => modulePaths.has(candidate))
  if (resolved) return { kind: 'source', path: resolved }
  return { kind: assetExtension.test(local) ? 'asset' : 'missing', path: local }
}

function isReactPackage(path: string) {
  return /^(?:react|react-dom|react-router|react-router-dom)(?:\/|$)/.test(path)
}

function forbiddenReason(rule: ArchitectureRule, dependency: ResolvedDependency, facts?: ModuleFacts): string | null {
  const path = dependency.path
  if (dependency.kind === 'missing') return 'Local runtime dependency could not be resolved.'
  if (rule === 'viewer-isolation') {
    return /^src\/(?:features|services|auth)\//.test(path) ||
      /(?:^|\/)(?:supabase|auth)(?:[./]|$)/i.test(path) || /^@(?:supabase|clerk)\//.test(path)
      ? 'The reusable viewer must not depend on business features, services, or authentication.'
      : null
  }
  if (isReactPackage(path) || facts?.hasJsx || stylesheet.test(path)) {
    return rule === 'service-presentation'
      ? 'Services must not depend on React, JSX presentation, or stylesheets.'
      : 'Pure data transformations must not depend on presentation.'
  }
  if (rule === 'pure-domain') {
    if (dependency.kind === 'external') return 'Pure data transformations use local runtime helpers; external packages need an explicit architecture review.'
    if (dependency.kind === 'asset') return 'Pure data transformations must not load assets.'
    if (/^src\/(?:services|app|viewer)\//.test(path) ||
      /(?:^|\/)(?:native[^/]*|[^/]*(?:Service|Store|Storage|Adapter))\.[cm]?[jt]sx?$/i.test(path) ||
      /(?:^|\/)(?:auth|supabase)(?:[./]|$)/i.test(path)) {
      return 'Pure data transformations must not depend on services, storage, authentication, or native bridges.'
    }
  }
  return null
}

/** Walks runtime edges through barrels/helpers; type-only edges never enter the graph. */
export function findArchitectureViolations(
  sources: ArchitectureSources,
  pureRoots: readonly string[] = PURE_DOMAIN_MODULES,
): ArchitectureViolation[] {
  const modulePaths = new Set([...sources.keys()].filter(isProductionSourcePath))
  const factsByPath = new Map<string, ModuleFacts>()
  const factsFor = (path: string) => {
    const cached = factsByPath.get(path)
    if (cached) return cached
    const source = sources.get(path)
    if (source === undefined || !modulePaths.has(path)) return undefined
    const facts = inspectModule(path, typeof source === 'function' ? source() : source)
    factsByPath.set(path, facts)
    return facts
  }
  const violations: ArchitectureViolation[] = []
  const roots: { path: string; rule: ArchitectureRule }[] = []
  for (const path of modulePaths) {
    if (path.startsWith('src/viewer/')) roots.push({ path, rule: 'viewer-isolation' })
    if (path.startsWith('src/services/')) roots.push({ path, rule: 'service-presentation' })
    if (pureRoots.includes(path)) roots.push({ path, rule: 'pure-domain' })
  }

  for (const root of roots) {
    const visited = new Set<string>()
    const queue = [{ path: root.path, chain: [root.path] }]
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]
      if (visited.has(current.path)) continue
      visited.add(current.path)
      for (const edge of factsFor(current.path)?.dependencies ?? []) {
        if (edge.typeOnly) continue
        const resolved = edge.specifier === null ? null : resolveDependency(current.path, edge.specifier, modulePaths)
        const reason = resolved
          ? forbiddenReason(root.rule, resolved) ?? forbiddenReason(root.rule, resolved, factsFor(resolved.path))
          : 'Computed runtime imports cannot be verified across this architecture boundary.'
        const chain = [...current.chain, resolved?.path ?? '<computed import>']
        if (reason) {
          violations.push({ rule: root.rule, importer: current.path, line: edge.line, specifier: edge.specifier, reason, chain })
        } else if (resolved?.kind === 'source') {
          queue.push({ path: resolved.path, chain })
        }
      }
    }
  }
  return violations
}

export function formatArchitectureViolation(violation: ArchitectureViolation) {
  return `${violation.rule}: ${violation.importer}:${violation.line}: ${violation.reason}\n  ${violation.chain.join(' → ')}`
}
