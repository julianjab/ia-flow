import { URL, fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // `''` as the 3rd arg to loadEnv: load every var regardless of a VITE_
  // prefix, matching what `process.env.VITE_API_TARGET` would've picked up
  // from a real shell export — an unprefixed .env value should behave the
  // same as one exported before the command. loadEnv reads apps/web/.env(.local)
  // (and mode-specific variants); a shell-exported VITE_API_TARGET still
  // wins since loadEnv falls back to process.env for anything already set.
  const env = loadEnv(mode, process.cwd(), '')
  // Default: apps/server local (bun run dev:server, :3001). Override to
  // point the SPA's dev/preview proxy at a different ia-flow API instance
  // — e.g. a runners/* container that publishes its API to the host — via
  // apps/web/.env (VITE_API_TARGET=http://localhost:3011) or
  // `VITE_API_TARGET=... bun run dev:web`.
  const apiTarget = env.VITE_API_TARGET ?? 'http://localhost:3001'

  return {
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
  }
})
