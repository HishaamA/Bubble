// Developer-only, read-only phone diagnostics. No images, names, identifiers,
// embeddings, or account keys leave the WebView: only aggregate counts.
import fs from 'node:fs/promises'
import ts from 'typescript'

const port = Number(process.argv[2] || 9226)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local debug port')
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json()
const tab = tabs.find((item) => item.type === 'page' && /^https:\/\/localhost\//.test(item.url))
if (!tab || !tab.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`)) throw new Error('Bubble WebView unavailable')
const source = await fs.readFile(new URL('../src/features/journal/people/peopleTimelineHelpers.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('helpers.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const printer = ts.createPrinter()
const withoutImports = parsed.statements.filter((node) => !ts.isImportDeclaration(node))
  .map((node) => printer.printNode(ts.EmitHint.Unspecified, node, parsed)).join('\n').replace(/^export /gm, '')
const helpers = ts.transpileModule(withoutImports, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText

const collect = async () => {
  const databases = await indexedDB.databases()
  if (!databases.some(({ name }) => name === 'kinsphere-people-timeline')) return { missingDatabase: true }
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('kinsphere-people-timeline')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(new Error('Database read failed'))
  })
  try {
    const stores = ['account-state', ...(db.objectStoreNames.contains('photo-face-scans') ? ['photo-face-scans'] : [])]
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readonly')
      const accounts = tx.objectStore('account-state').getAll()
      const keys = tx.objectStore('account-state').getAllKeys()
      const scans = stores.length > 1 ? tx.objectStore('photo-face-scans').getAll() : null
      const scanKeys = stores.length > 1 ? tx.objectStore('photo-face-scans').getAllKeys() : null
      tx.oncomplete = () => resolve({ accounts: accounts.result, keys: keys.result, scans: scans?.result ?? [], scanKeys: scanKeys?.result ?? [] })
      tx.onerror = () => reject(new Error('Database read failed'))
    })
    return rows.accounts.map((state, accountIndex) => {
      if (state.faceScanStorage?.version === 1) {
        state.faceScans = Object.fromEntries(rows.scanKeys.flatMap((key, index) => Array.isArray(key) && key[0] === rows.keys[accountIndex] ? [[key[1], rows.scans[index]]] : []))
      }
      const scans = Object.entries(state.faceScans ?? {})
      const references = referenceProfiles(state)
      const matchStarted = performance.now()
      const auto = createFaceSuggestions(state)
      const review = createFaceReviewCandidates(state, undefined, undefined, undefined, auto)
      const matchDurationMs = Math.round(performance.now() - matchStarted)
      const family = new Map()
      for (const match of [...state.assignments.filter((a) => a.source === 'manual'), ...auto]) {
        const set = family.get(match.photoKey) ?? new Set(); set.add(match.personId); family.set(match.photoKey, set)
      }
      const hist = { totalFaces: 0, noFaces: 0, multipleFaces: 0, detailMissing: 0, under48px: 0, detail48to80px: 0, detail80plus: 0, quality75plus: 0, allAutomaticQualityGates: 0, invalidDescriptor: 0 }
      for (const [, scan] of scans) {
        if (!scan.faces.length) hist.noFaces++
        if (scan.faces.length >= 2) hist.multipleFaces++
        for (const face of scan.faces) {
          hist.totalFaces++
          if (face.minFacePixels === undefined) hist.detailMissing++
          const detail = faceDetailPixels(face)
          if (detail < 48) hist.under48px++
          else if (detail < 80) hist.detail48to80px++
          else hist.detail80plus++
          if (face.quality >= .75) hist.quality75plus++
          if (face.quality >= .75 && face.detectorScore >= .75 && face.descriptorScore >= .75 && detail >= 80) hist.allAutomaticQualityGates++
          if (face.embedding.length !== 1024 || !face.embedding.every(Number.isFinite) || !face.embedding.some((x) => x !== 0)) hist.invalidDescriptor++
        }
      }
      return {
        accountOrdinal: accountIndex, people: state.people.length, scans: scans.length,
        visibleGalleryProgress: (() => { const progress = document.querySelector('.gallery-scan progress'); return progress ? { checked: progress.value, total: progress.max } : null })(),
        matchingDurationMs: matchDurationMs,
        galleryScans: scans.filter(([key]) => key.startsWith('journal-photo:device-gallery:')).length,
        manualAssignments: state.assignments.filter((a) => a.source === 'manual').length,
        legacyAutomaticAssignments: state.assignments.filter((a) => a.source !== 'manual').length,
        dismissals: state.dismissedSuggestions.length, automaticMatches: auto.length, reviewMatches: review.length,
        familyMatchedPhotos: [...family.values()].filter((x) => x.size >= 2).length,
        hist,
        scanEras: [false, true].map((recent) => {
          const selected = scans.filter(([, scan]) => (Date.parse(scan.scannedAt) >= Date.parse('2026-09-14T06:43:27Z')) === recent)
          return { sinceBackgroundUpdate: recent, scans: selected.length, noFaces: selected.filter(([, s]) => !s.faces.length).length,
            faces: selected.reduce((n, [, s]) => n + s.faces.length, 0), multipleFaces: selected.filter(([, s]) => s.faces.length >= 2).length }
        }),
        profiles: state.people.map(({ id }, ordinal) => {
          const refs = references.find((p) => p.personId === id)?.references ?? []
          const scores = { above78: 0, above86: 0, above92: 0, automaticReferencePassed: 0, highQualityAbove78: 0 }
          for (const [, scan] of scans) for (const face of scan.faces) {
            const score = strongestReferenceSimilarity(face.embedding, refs)
            if (score >= .78) scores.above78++
            if (score >= .86) scores.above86++
            if (score >= .92) scores.above92++
            if (automaticReferenceConfidence(face.embedding, refs, .86) >= .86) scores.automaticReferencePassed++
            if (score >= .78 && face.quality >= .75 && faceDetailPixels(face) >= 80) scores.highQualityAbove78++
          }
          return { ordinal, references: refs.length, enrollment: refs.filter((r) => r.source === 'enrollment').length,
            manualLabels: state.assignments.filter((a) => a.personId === id && a.source === 'manual').length,
            faceSpecificLabels: state.assignments.filter((a) => a.personId === id && a.source === 'manual' && a.faceId).length,
            manualWithProvenance: refs.filter((r) => r.source === 'manual-photo' && r.photoKey && r.faceId).length,
            saturatedDifferentPairs: refs.reduce((n, a, i) => n + refs.slice(i + 1).filter((b) => faceResSimilarity(a.embedding, b.embedding) === 1 && !a.embedding.every((x, j) => x === b.embedding[j])).length, 0),
            noReferenceQuality: refs.filter((r) => r.quality === undefined).length,
            autoTrustedReferences: refs.filter((r) => r.quality >= .62).length,
            qualityRange: refs.map((r) => r.quality === undefined ? null : Math.round(r.quality * 100) / 100),
            auto: auto.filter((x) => x.personId === id).length, review: review.filter((x) => x.personId === id).length, scores }
        }),
      }
    })
  } finally { db.close() }
}

const socket = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.close(); reject(new Error('Phone debug connection timed out')) }, 5000)
  socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
  socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Phone debug connection failed')) }, { once: true })
  socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Phone debug connection closed')) }, { once: true })
})
try {
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Aggregate diagnostic timed out')), 120000)
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.id !== 1) return
      clearTimeout(timeout)
      if (message.error || message.result?.exceptionDetails) reject(new Error('Read-only aggregate evaluation failed'))
      else resolve(message.result.result.value)
    })
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(async () => { ${helpers}\n return (${collect.toString()})(); })()`,
      awaitPromise: true, returnByValue: true,
    } }))
  })
  console.log(JSON.stringify(response, null, 2))
} finally { socket.close() }
