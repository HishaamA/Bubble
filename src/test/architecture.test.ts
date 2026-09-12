// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  findArchitectureViolations,
  formatArchitectureViolation,
  isExcludedSourcePath,
  isProductionSourcePath,
  PURE_DOMAIN_MODULES,
  type ArchitectureRule,
  type ArchitectureViolation,
} from './architectureRules'

/** Inventory the production tree, reading only guarded roots and runtime dependencies. */
function readProductionSources(directory: string, moduleDirectory = 'src'): Map<string, () => string> {
  const sources = new Map<string, () => string>()
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = `${moduleDirectory}/${entry.name}`
    if (isExcludedSourcePath(path)) continue
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const [childPath, source] of readProductionSources(absolutePath, path)) sources.set(childPath, source)
    } else if (entry.isFile() && isProductionSourcePath(path)) {
      sources.set(path, () => readFileSync(absolutePath, 'utf8'))
    }
  }
  return sources
}

describe('production architecture boundaries', () => {
  let sources: Map<string, () => string>
  let violations: ArchitectureViolation[]
  beforeAll(() => {
    sources = readProductionSources(fileURLToPath(new URL('../', import.meta.url)))
    violations = findArchitectureViolations(sources)
  })

  it('discovers the guarded layers and all explicitly pure modules', () => {
    expect([...sources.keys()].some((path) => path.startsWith('src/viewer/'))).toBe(true)
    expect([...sources.keys()].some((path) => path.startsWith('src/services/'))).toBe(true)
    for (const path of PURE_DOMAIN_MODULES) expect(sources.has(path), path).toBe(true)
  })

  it.each<ArchitectureRule>(['viewer-isolation', 'service-presentation', 'pure-domain'])(
    '%s remains independent through all runtime imports and re-exports',
    (rule) => {
      expect(violations.filter((violation) => violation.rule === rule).map(formatArchitectureViolation)).toEqual([])
    },
  )
})
