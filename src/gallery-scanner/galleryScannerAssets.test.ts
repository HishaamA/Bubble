import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HUMAN_MODEL_BASE_PATH,
  TFJS_WASM_ASSET_PATH,
  TFJS_WASM_VERSION,
} from '../features/journal/people/faceRecognitionPipeline'

const require = createRequire(import.meta.url)
const repositoryRoot = resolve(import.meta.dirname, '../..')
const wasmDist = dirname(require.resolve('@tensorflow/tfjs-backend-wasm'))
const humanDist = dirname(require.resolve('@vladmandic/human'))
const wasmFiles = [
  'tfjs-backend-wasm.wasm',
  'tfjs-backend-wasm-simd.wasm',
  'tfjs-backend-wasm-threaded-simd.wasm',
]

describe('gallery scanner local assets', () => {
  it('pins binaries to the TensorFlow version actually bundled by Human', () => {
    const wasmPackage = JSON.parse(readFileSync(
      resolve(wasmDist, '..', 'package.json'),
      'utf8',
    )) as { version?: string }
    const humanTfjsVersions = readFileSync(
      resolve(humanDist, 'tfjs.version.js'),
      'utf8',
    )

    expect(wasmPackage.version).toBe(TFJS_WASM_VERSION)
    expect(humanTfjsVersions).toContain(`"${TFJS_WASM_VERSION}"`)
    for (const filename of wasmFiles) {
      const binary = readFileSync(resolve(wasmDist, filename))
      expect([...binary.subarray(0, 4)]).toEqual([0, 97, 115, 109])
    }
  })

  it('builds a locked-down second page with only local model, photo, and WASM paths', () => {
    const html = readFileSync(resolve(repositoryRoot, 'gallery-scanner.html'), 'utf8')
    const viteConfig = readFileSync(resolve(repositoryRoot, 'vite.config.ts'), 'utf8')
    const runtime = readFileSync(
      resolve(repositoryRoot, 'src/gallery-scanner/galleryFaceScannerRuntime.ts'),
      'utf8',
    )

    expect(html).toContain("default-src 'none'")
    expect(html).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(html).toContain('src="/src/gallery-scanner.ts"')
    expect(html).not.toMatch(/src="https?:|href="https?:/i)
    expect(viteConfig).toContain("galleryScanner: resolve(projectRoot, 'gallery-scanner.html')")
    expect(viteConfig).toContain(`fileName: \`vendor/tfjs-wasm/\${filename}\``)
    expect(runtime).toContain('`/photo/${encodeURIComponent(nativeId)}`')
    expect(HUMAN_MODEL_BASE_PATH).toBe('/models/human/')
    expect(TFJS_WASM_ASSET_PATH).toBe('/vendor/tfjs-wasm/')
  })
})
