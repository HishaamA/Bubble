import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const require = createRequire(import.meta.url)
const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const tfjsWasmDist = dirname(require.resolve('@tensorflow/tfjs-backend-wasm'))
const tfjsWasmFiles = [
  'tfjs-backend-wasm.wasm',
  'tfjs-backend-wasm-simd.wasm',
  'tfjs-backend-wasm-threaded-simd.wasm',
] as const

/** Serves the pinned TFJS binaries in development and emits the same bytes in builds. */
function bundledTfjsWasmAssets(): Plugin {
  const assets = new Map(tfjsWasmFiles.map((filename) => [
    filename,
    readFileSync(resolve(tfjsWasmDist, filename)),
  ]))
  const webPrefix = '/vendor/tfjs-wasm/'
  return {
    name: 'bubble-local-tfjs-wasm',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://vite.local').pathname
        if (!pathname.startsWith(webPrefix)) {
          next()
          return
        }
        const filename = pathname.slice(webPrefix.length)
        const asset = assets.get(filename as typeof tfjsWasmFiles[number])
        if (!asset) {
          next()
          return
        }
        response.statusCode = 200
        response.setHeader('Content-Type', 'application/wasm')
        response.setHeader('Cache-Control', 'no-transform, public, max-age=31536000, immutable')
        response.setHeader('Content-Length', asset.byteLength)
        response.end(asset)
      })
    },
    generateBundle() {
      for (const [filename, source] of assets) {
        this.emitFile({
          type: 'asset',
          fileName: `vendor/tfjs-wasm/${filename}`,
          source,
        })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), bundledTfjsWasmAssets()],
  server: {
    // LAN binding lets an installed-phone candidate use the same preview during
    // explicit device testing; strictPort prevents a silently different URL.
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    watch: {
      // Native models/builds and private diagnostic captures are not web inputs.
      // Watching them can trigger costly rescans during on-device stitch testing.
      ignored: [
        '**/private-media/**',
        '**/.native-deps/**',
        '**/.venv/**',
        '**/android/**',
        '**/ios/**',
      ],
    },
    proxy: {
      '/api/generation': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
        timeout: 180_000,
        proxyTimeout: 180_000,
      },
      // Keep frame uploads on the app origin. The worker is a local companion
      // process; Python and learned model weights never enter the web bundle.
      '/api/stitch': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        timeout: 120_000,
        proxyTimeout: 120_000,
      },
    },
  },
  build: {
    // Clerk includes native BigInt literals, first supported by Chrome 67.
    // Safari 15 remains the oldest supported iOS WebView baseline.
    target: ['chrome67', 'safari15'],
    rolldownOptions: {
      input: {
        app: resolve(projectRoot, 'index.html'),
        galleryScanner: resolve(projectRoot, 'gallery-scanner.html'),
      },
      output: {
        // Keep frequently reused frameworks and service SDKs in named,
        // content-hashed chunks. Route edits can then ship without forcing the
        // browser to download unchanged Clerk, Supabase, or React code again.
        codeSplitting: {
          maxSize: 450_000,
          groups: [
            {
              name: 'vendor-face',
              test: /node_modules[\\/]@vladmandic[\\/]human[\\/]/,
              priority: 40,
              includeDependenciesRecursively: false,
            },
            {
              name: 'vendor-clerk',
              test: /node_modules[\\/]@clerk[\\/]/,
              priority: 30,
              includeDependenciesRecursively: false,
            },
            {
              name: 'vendor-supabase',
              test: /node_modules[\\/]@supabase[\\/]/,
              priority: 20,
              includeDependenciesRecursively: false,
            },
            {
              name: 'vendor-react',
              test: /node_modules[\\/](?:react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
              priority: 10,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
    // Human is a single upstream ESM module, so it cannot be split internally.
    // It is fetched only when face recognition starts; its 1.57 MB raw size
    // (about 412 KB gzip) is the documented exception to the normal budget.
    chunkSizeWarningLimit: 1_600,
  },
})
