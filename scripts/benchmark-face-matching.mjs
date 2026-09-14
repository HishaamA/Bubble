// Synthetic CPU benchmark only; never loads family photos or descriptors.
import fs from 'node:fs/promises'
import ts from 'typescript'
import { performance } from 'node:perf_hooks'

const text = await fs.readFile(new URL('../src/features/journal/people/peopleTimelineHelpers.ts', import.meta.url), 'utf8')
const source = ts.createSourceFile('helpers.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const printer = ts.createPrinter()
const code = source.statements.filter((node) => !ts.isImportDeclaration(node))
  .map((node) => printer.printNode(ts.EmitHint.Unspecified, node, source)).join('\n').replace(/^export /gm, '')
const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const { createFaceSuggestions, createFaceReviewCandidates } = new Function(`${js}; return { createFaceSuggestions, createFaceReviewCandidates };`)()
let seed = 23
const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296 }
const vector = (person) => Array.from({ length: 1024 }, () => 2 + person * .7 + (random() - .5) * .35)
const face = (person) => ({ id: 'face-1', embedding: vector(person), quality: .9, detectorScore: .95,
  descriptorScore: .95, minFacePixels: 128, box: [.1, .1, .3, .3] })
const state = { people: [], assignments: [], faceProfiles: {}, faceScans: {}, dismissedSuggestions: [] }
for (let person = 0; person < 3; person++) {
  const id = `person-${person}`
  state.people.push({ id, name: id, createdAt: '2026-01-01' })
  state.faceProfiles[id] = { references: [{ id: `ref-${person}`, source: 'enrollment', quality: .9,
    embedding: vector(person), createdAt: '2026-01-01' }] }
  for (let index = 0; index < [8, 9, 47][person]; index++) {
    const key = `confirmed-${person}-${index}`
    state.faceScans[key] = { scannedAt: '2026-01-01', faces: [face(person)] }
    state.assignments.push({ photoKey: key, personId: id, faceId: 'face-1', source: 'manual', confirmedAt: '2026-01-01' })
  }
}
for (let index = 0; index < 1800; index++) state.faceScans[`candidate-${index}`] = {
  scannedAt: '2026-01-01', faces: [face(index % 3)],
}
const timings = []
for (let run = 0; run < 2; run++) {
  const start = performance.now()
  const automatic = createFaceSuggestions(state)
  const review = createFaceReviewCandidates(state, undefined, undefined, undefined, automatic)
  timings.push({ run: run === 0 ? 'cold' : 'cached', milliseconds: Math.round(performance.now() - start), automatic: automatic.length, review: review.length })
}
console.log(JSON.stringify({ syntheticFaces: Object.keys(state.faceScans).length, manualReferences: 64, timings }, null, 2))
