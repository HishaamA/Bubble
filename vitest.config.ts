import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    // The local companion's real HTTP tests use Node's test runner.
    exclude: [...configDefaults.exclude, 'services/generation/**/*.test.mjs'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // The full mobile UI suite is memory-heavy under jsdom. Bounding workers
    // prevents otherwise healthy interaction tests from starving and timing out.
    maxWorkers: 4,
  },
})
