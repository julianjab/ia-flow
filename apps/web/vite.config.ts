import { URL, fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

const DEFAULT_WEB_PORT = 5173
const DEFAULT_SERVER_PORT = 3001

function readPort(env: Record<string, string>, keys: string[], fallback: number) {
  for (const key of keys) {
    const raw = env[key]?.trim()
    if (!raw) continue
    const port = Number.parseInt(raw, 10)
    if (Number.isInteger(port) && port > 0 && port < 65536) return { port, explicit: true }
    throw new Error(`${key} inválido: "${raw}" — debe ser un entero entre 1 y 65535`)
  }
  return { port: fallback, explicit: false }
}

export default defineConfig(({ mode }) => {
  // `''` as the 3rd arg to loadEnv: load every var regardless of a VITE_
  // prefix, matching what `process.env.VITE_API_TARGET` would've picked up
  // from a real shell export — an unprefixed .env value should behave the
  // same as one exported before the command. Two dirs are read so a single
  // .env at the repo root can configure both apps (IA_FLOW_SERVER_PORT +
  // IA_FLOW_WEB_PORT); apps/web/.env wins over the root one, and a
  // shell-exported var still beats both since loadEnv falls back to
  // process.env for anything already set.
  const rootDir = fileURLToPath(new URL('../..', import.meta.url))
  const env = { ...loadEnv(mode, rootDir, ''), ...loadEnv(mode, process.cwd(), '') }

  // Puerto del SPA: IA_FLOW_WEB_PORT (o VITE_WEB_PORT) — cuando viene de env
  // usamos strictPort para fallar en vez de saltar al siguiente libre, que es
  // lo que rompería un proxy/túnel apuntado a ese puerto.
  const web = readPort(env, ['IA_FLOW_WEB_PORT', 'VITE_WEB_PORT'], DEFAULT_WEB_PORT)

  // Default: apps/server local (bun run dev:server, :3001), siguiendo el
  // mismo IA_FLOW_SERVER_PORT/PORT que resuelve el server. Override total del
  // destino (host incluido) con VITE_API_TARGET — e.g. un runners/* container
  // que publica su API al host: VITE_API_TARGET=http://localhost:3011.
  const serverPort = readPort(env, ['IA_FLOW_SERVER_PORT', 'PORT'], DEFAULT_SERVER_PORT).port
  const apiTarget = env.VITE_API_TARGET || `http://localhost:${serverPort}`

  const proxy = {
    '/api': {
      target: apiTarget,
      changeOrigin: true,
    },
    '/ws': {
      target: apiTarget,
      ws: true,
      changeOrigin: true,
    },
  }

  return {
    plugins: [vue()],
    build: {
      rollupOptions: {
        // Dos entries: la SPA de siempre y la consola del gateway
        // (src/gateway-main.ts). Es otra pantalla contra otro proceso, no una
        // ruta más de la app — comparte tema y componentes, no el router ni
        // el axios global. La app de Electron sirve `gateway.html` del dist.
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          gateway: fileURLToPath(new URL('./gateway.html', import.meta.url)),
        },
      },
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      // Los componentes que llaman al server con URL absoluta caen a
      // `import.meta.env.VITE_API_BASE`; sin esto su default hardcodeado
      // seguiría apuntando a :3001 aunque el server corra en otro puerto.
      'import.meta.env.VITE_API_BASE': JSON.stringify(env.VITE_API_BASE || apiTarget),
    },
    server: {
      port: web.port,
      strictPort: web.explicit,
      proxy,
    },
    preview: {
      port: web.port,
      strictPort: web.explicit,
      proxy,
    },
  }
})
