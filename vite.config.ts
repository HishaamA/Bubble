import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // LAN binding lets an installed-phone candidate use the same preview during
    // explicit device testing; strictPort prevents a silently different URL.
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  build: {
    // Clerk includes native BigInt literals, first supported by Chrome 67.
    // Safari 15 remains the oldest supported iOS WebView baseline.
    target: ['chrome67', 'safari15'],
    rolldownOptions: {
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
