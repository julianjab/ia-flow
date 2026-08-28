import { URL, fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: './vitest.environment.ts',
    globals: true,
    include: ['src/**/*.test.ts'],
    // Ver src/test/setup.ts: Node >=22 pisa los globals de storage de
    // happy-dom y hay que reinstalarlos antes de los tests.
    setupFiles: ['./src/test/setup.ts'],
  },
})
