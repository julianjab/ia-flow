import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

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

/**
 * Runners remotos a través de esta web: `IA_FLOW_PROXY_RUNNERS=prod=https://runner.interno` sirve cada uno bajo
 * `/<nombre>/…` (`/prod/api/inbox` → `https://runner.interno/api/inbox`): un runner al que sólo llega esta máquina
 * (detrás de una VPN) se usa desde el teléfono agregando `https://<esta web>/<nombre>` con su token. Expuesta, la
 * web va detrás de Cloudflare Access, y el runner sigue pidiendo su token.
 */
export function remoteRunnerProxies(raw: string | undefined): Record<string, ProxyOptions> {
  const out: Record<string, ProxyOptions> = {}
  for (const entry of (raw ?? '').split(',')) {
    const eq = entry.indexOf('=')
    if (eq < 0) continue
    const name = entry.slice(0, eq).trim()
    const target = entry
      .slice(eq + 1)
      .trim()
      .replace(/\/+$/, '')
    if (!/^[a-z0-9-]+$/.test(name) || !/^https?:\/\//.test(target)) continue
    const prefix = `/${name}`
    out[`^${prefix}/`] = {
      target,
      changeOrigin: true,
      rewrite: (path) => path.slice(prefix.length),
    }
  }
  return out
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

  // Default: el runner local (apps/runner-v2 con --serve, :3001), siguiendo el
  // mismo IA_FLOW_SERVER_PORT (o PORT) que resuelve el runner. Override total del
  // destino (host incluido) con VITE_API_TARGET — e.g. un runner en container
  // que publica su API al host: VITE_API_TARGET=http://localhost:3011.
  const serverPort = readPort(env, ['IA_FLOW_SERVER_PORT', 'PORT'], DEFAULT_SERVER_PORT).port
  const apiTarget = env.VITE_API_TARGET || `http://localhost:${serverPort}`

  // Hosts que el dev server acepta en el header `Host`. Vite bloquea todo lo
  // que no sea localhost/IP —defensa contra DNS rebinding—, así que exponer
  // esta app por un túnel (Cloudflare, ngrok) devuelve "Blocked request" sin
  // esto. `true` acepta cualquiera; una lista separada por comas es lo
  // preferible cuando el hostname del túnel es estable.
  const allowedHosts =
    env.IA_FLOW_ALLOWED_HOSTS === 'true'
      ? true
      : env.IA_FLOW_ALLOWED_HOSTS
        ? env.IA_FLOW_ALLOWED_HOSTS.split(',').map((h) => h.trim())
        : undefined

  const proxy: Record<string, ProxyOptions> = {
    '/api': {
      target: apiTarget,
      changeOrigin: true,
    },
    ...remoteRunnerProxies(env.IA_FLOW_PROXY_RUNNERS),
  }

  return {
    plugins: [vue()],
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
      allowedHosts,
    },
    preview: {
      port: web.port,
      strictPort: web.explicit,
      proxy,
      allowedHosts,
    },
  }
})
