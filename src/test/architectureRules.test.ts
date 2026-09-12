// @vitest-environment node
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import {
  findArchitectureViolations,
  formatArchitectureViolation,
  inspectModule,
  isProductionSourcePath,
} from './architectureRules'

const pureRoot = 'src/features/example/selection.ts'
const inspectGraph = (sources: Record<string, string>) =>
  findArchitectureViolations(new Map(Object.entries(sources)), [pureRoot])

describe('architecture import inspection', () => {
  it.each([
    ["import value from 'package'", false],
    ["import { type Contract, value } from 'package'", false],
    ["import value, { type Contract } from 'package'", false],
    ["import 'package'", false],
    ["import {} from 'package'", false],
    ["import type { Contract } from 'package'", true],
    ["import type * as Contracts from 'package'", true],
    ["import { type Contract, type Other } from 'package'", false],
    ["export * from 'package'", false],
    ["export * as namespace from 'package'", false],
    ["export { type Contract, value } from 'package'", false],
    ["export type * from 'package'", true],
    ["export type { Contract } from 'package'", true],
    ["export { type Contract } from 'package'", false],
    ["const load = () => import('package')", false],
    ['const load = () => import(`package`)', false],
    ["const load = () => require('package')", false],
    ["import runtime = require('package')", false],
    ["import type Contract = require('package')", true],
    ["type Contract = import('package').Contract", true],
    ["type Contract = typeof import('package')", true],
  ])('classifies %s without treating erased contracts as runtime dependencies', (source, typeOnly) => {
    expect(inspectModule('src/example.ts', source).dependencies).toEqual([
      { specifier: 'package', typeOnly, line: 1 },
    ])
  })

  it.each([
    "import { type Contract } from 'package'",
    "export { type Contract } from 'package'",
    "import type { Contract } from 'package'",
    "export type { Contract } from 'package'",
  ])('matches the emitted runtime graph under verbatimModuleSyntax: %s', (source) => {
    const emitted = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
    }).outputText
    const runtimeSpecifiers = (text: string) => inspectModule('src/example.ts', text)
      .dependencies.filter(({ typeOnly }) => !typeOnly).map(({ specifier }) => specifier)
    expect(runtimeSpecifiers(source)).toEqual(runtimeSpecifiers(emitted))
  })

  it('ignores import-looking comments and strings, and reports real import lines', () => {
    const source = `// import bad from 'comment'
const label = "import bad from 'string'"
import {
  value,
  type Contract,
} from 'real'
`
    expect(inspectModule('src/example.ts', source).dependencies).toEqual([
      { specifier: 'real', typeOnly: false, line: 3 },
    ])
  })

  it.each(['src/viewer/Viewer.test.tsx', 'src/services/api.spec.ts', 'src/features/Card.stories.tsx', 'src/test/manual/Screen.tsx', 'src/features/__fixtures__/sample.ts', 'src/features/__tests__/sample.ts', 'src/features/types.d.ts'])('excludes non-production source %s', (path) => {
    expect(isProductionSourcePath(path)).toBe(false)
  })
})

describe('architecture graph rules', () => {
  it('allows type-only contracts across every boundary', () => {
    expect(inspectGraph({
      'src/viewer/Viewer.ts': "import type { Member } from '../services/api'; export type { Screen } from '../features/profile/Screen'",
      'src/services/api.ts': "import type { Screen } from '../features/profile/Screen'",
      'src/features/profile/Screen.tsx': "import React from 'react'; export const Screen = () => <div />",
      [pureRoot]: "import type { Member } from '../../services/api'; type Native = import('@capacitor/core').Plugin",
    })).toEqual([])
  })

  it.each([
    "import { value } from '../features/events/model'",
    "export * from '../features/events/model'",
    "const load = () => import('../features/events/model')",
  ])('rejects viewer business dependencies through %s', (source) => {
    expect(inspectGraph({
      'src/viewer/adapter.ts': source,
      'src/features/events/model.ts': 'export const value = 1',
    })).toEqual([expect.objectContaining({ rule: 'viewer-isolation', importer: 'src/viewer/adapter.ts' })])
  })

  it('finds viewer authentication leakage behind a barrel and resolves emitted JS imports', () => {
    const violations = inspectGraph({
      'src/viewer/adapter.ts': "export { connect } from '../lib/bridge.js'",
      'src/lib/bridge.ts': "export { connect } from './session'",
      'src/lib/session/index.ts': "export { createClient as connect } from '@supabase/supabase-js'",
    })
    expect(violations).toEqual([expect.objectContaining({
      rule: 'viewer-isolation',
      chain: ['src/viewer/adapter.ts', 'src/lib/bridge.ts', 'src/lib/session/index.ts', '@supabase/supabase-js'],
    })])
    expect(formatArchitectureViolation(violations[0])).toContain('src/lib/session/index.ts:1:')
  })

  it('allows services to use feature-domain helpers and native capabilities', () => {
    expect(inspectGraph({
      'src/services/media/compose.ts': "import { nativeFrame } from '../../features/capture/nativeCapture'",
      'src/features/capture/nativeCapture.ts': "import { registerPlugin } from '@capacitor/core'; export const nativeFrame = registerPlugin('Capture')",
      'src/services/persistence/api.ts': "import { createClient } from '@supabase/supabase-js'",
    })).toEqual([])
  })

  it('also catches the implicit JSX runtime when presentation is put in a guarded root', () => {
    const violations = findArchitectureViolations(new Map([
      ['src/services/component.tsx', 'export const Screen = () => <div />'],
      ['src/features/example/selection.tsx', 'export const choose = () => <span />'],
    ]), ['src/features/example/selection.tsx'])
    expect(violations.map(({ rule, specifier }) => ({ rule, specifier }))).toEqual([
      { rule: 'service-presentation', specifier: 'react/jsx-runtime' },
      { rule: 'pure-domain', specifier: 'react/jsx-runtime' },
    ])
  })

  it.each([
    ['src/features/profile/Screen.tsx', 'export const Screen = () => <div />'],
    ['src/features/profile/useProfile.ts', "import { useState } from 'react'; export const Screen = useState"],
    ['src/features/profile/style.ts', "import './Screen.css'; export const Screen = null"],
  ])('rejects services reaching presentation via a feature barrel: %s', (path, source) => {
    const module = path.slice('src/features/profile/'.length).replace(/\.tsx?$/, '')
    expect(inspectGraph({
      'src/services/api.ts': "import { Screen } from '../features/profile'",
      'src/features/profile/index.ts': `export { Screen } from './${module}'`,
      [path]: source,
    })).toEqual([expect.objectContaining({ rule: 'service-presentation' })])
  })

  it('walks pure local helpers through cycles without following their type imports', () => {
    expect(inspectGraph({
      [pureRoot]: "import { choose } from './helper'; import type { Snapshot } from '../remote/remoteStore'",
      'src/features/example/helper.ts': "export { choose } from './index'",
      'src/features/example/index.ts': "import './selection'; export const choose = (items: string[]) => items[0]",
    })).toEqual([])
  })

  it.each([
    ['src/features/remote/remoteStore.ts', 'export const data = []'],
    ['src/features/remote/nativeBridge.ts', 'export const data = []'],
    ['src/features/remote/remoteService.ts', 'export const data = []'],
    ['src/features/remote/client.ts', "import axios from 'axios'; export const data = axios"],
  ])('rejects transitive pure-domain capability dependencies: %s', (path, source) => {
    const module = path.slice('src/features/remote/'.length).replace(/\.ts$/, '')
    expect(inspectGraph({
      [pureRoot]: "import { data } from './helper'",
      'src/features/example/helper.ts': `export { data } from '../remote/${module}'`,
      [path]: source,
    })).toEqual([expect.objectContaining({ rule: 'pure-domain' })])
  })

  it('fails closed for unresolved or computed runtime imports, but ignores computed import-looking text', () => {
    const violations = inspectGraph({
      [pureRoot]: "import './missing'; const load = (name: string) => import(name); const text = 'import(name)'",
    })
    expect(violations).toHaveLength(2)
    expect(violations.map(({ specifier }) => specifier)).toEqual(['./missing', null])
  })

  it('does not enforce production rules against tests or manual fixture modules', () => {
    expect(inspectGraph({
      'src/viewer/adapter.test.ts': "import Screen from '../features/profile/Screen'",
      'src/test/manual/Screen.tsx': "import React from 'react'; export const Screen = () => <div />",
    })).toEqual([])
  })

  it('reads each reachable runtime module once without opening unrelated or type-only sources', () => {
    const untouched = vi.fn(() => { throw new Error('Unrelated source must not be opened') })
    const sharedHelper = vi.fn(() => 'export const choose = (items: string[]) => items[0]')
    const sources = new Map<string, string | (() => string)>([
      ['src/viewer/adapter.ts', "import { choose } from '../lib/choice'; import type { Member } from '../features/contract'"],
      ['src/viewer/other.ts', "import { choose } from '../lib/choice'"],
      ['src/lib/choice.ts', sharedHelper],
      ['src/features/contract.ts', untouched],
      ['src/features/unrelated.tsx', untouched],
    ])
    expect(findArchitectureViolations(sources, [])).toEqual([])
    expect(sharedHelper).toHaveBeenCalledTimes(1)
    expect(untouched).not.toHaveBeenCalled()
  })
})
