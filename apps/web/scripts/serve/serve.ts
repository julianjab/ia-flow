/**
 * La web instalada (`installer/`): sirve el build de la SPA y proxea `/api` al runner, como `vite preview` pero sin
 * vite ni `node_modules`. El instalador la empaqueta con `bun build` y la corre su LaunchAgent
 * (`link.julianjab.ia-flow-web`); el túnel de Cloudflare apunta a este puerto.
 *
 *   IA_FLOW_WEB_DIR         el build (`apps/web/dist`); por defecto `web/` junto a este archivo
 *   IA_FLOW_WEB_PORT        5173
 *   IA_FLOW_WEB_BIND        127.0.0.1 (el túnel llega por localhost)
 *   IA_FLOW_RUNNER_URL      el runner de `/api`: http://localhost:3001
 *   IA_FLOW_PROXY_RUNNERS   `nombre=URL,…`: cada uno bajo `/<nombre>/…` (ver `vite.config.ts`)
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { forwardHeaders, parseProxyRunners, route } from './routes.js'

const env = process.env
const dir = env.IA_FLOW_WEB_DIR || join(import.meta.dir, 'web')
const port = Number(env.IA_FLOW_WEB_PORT || 5173)
const config = {
  runner: (env.IA_FLOW_RUNNER_URL || 'http://localhost:3001').replace(/\/+$/, ''),
  runners: parseProxyRunners(env.IA_FLOW_PROXY_RUNNERS),
}

if (!existsSync(join(dir, 'index.html'))) {
  process.stderr.write(`[ia-flow-web] no hay build en ${dir} (falta index.html)\n`)
  process.exit(1)
}

const isFile = (path: string) => {
  try {
    return statSync(join(dir, path)).isFile()
  } catch {
    return false
  }
}

async function proxy(req: Request, target: string): Promise<Response> {
  try {
    const res = await fetch(target, {
      method: req.method,
      headers: forwardHeaders(req.headers),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      redirect: 'manual',
      // los streams (SSE del inbox y del asistente) no tienen que cortarse por un timeout
      signal: req.signal,
    })
    const headers = new Headers(res.headers)
    // fetch ya descomprimió el cuerpo: el largo y la codificación de origen ya no valen
    headers.delete('content-encoding')
    headers.delete('content-length')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: `el runner no responde (${target}): ${message}` },
      { status: 502 },
    )
  }
}

function file(path: string, cache: 'immutable' | 'revalidate'): Response {
  return new Response(Bun.file(join(dir, path)), {
    headers: {
      'cache-control': cache === 'immutable' ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  })
}

const server = Bun.serve({
  port,
  hostname: env.IA_FLOW_WEB_BIND || '127.0.0.1',
  // el SSE pasa horas abierto: sin esto Bun corta la conexión a los 10 s sin datos
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url)
    const target = route(url.pathname, url.search, config, isFile)
    if (target.kind === 'proxy') return proxy(req, target.target)
    if (target.kind === 'file') return file(target.path, target.cache)
    return file('index.html', 'revalidate')
  },
})

process.stdout.write(
  `[ia-flow-web] ${dir} en http://${server.hostname}:${server.port} → /api a ${config.runner}\n`,
)
