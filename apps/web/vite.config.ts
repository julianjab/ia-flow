import { URL, fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// Default: apps/server local (bun run dev:server, :3001). Override to point
// the SPA's dev/preview proxy at a different ia-flow API instance without
// editing this file — e.g. a runners/* container that publishes its API to
// the host (VITE_API_TARGET=http://localhost:3011 bun run dev:web for
// runners/subscriptions-pipeline).
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:3001'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: apiTarget,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: apiTarget,
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
