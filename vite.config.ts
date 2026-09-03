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
  },
})
