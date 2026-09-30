/**
 * Los MCP que el runner levanta él mismo y publica en `/mcp/<id>` de su puerto (`mcpHost:` de
 * runner.yaml): el de Figma (`figma-developer-mcp`), la memoria de los agentes (`server-memory`
 * detrás de `supergateway`)… Cada uno es un proceso hijo que escucha en loopback; el runner valida
 * un bearer propio por entrada (esos procesos no autentican nada) y recién ahí reenvía.
 *
 * Por qué acá y no en un gateway aparte: a estos MCP los llama Anthropic (van en `mcp_servers` de
 * la Messages API), así que tienen que ser públicos — y el runner ya lo es. Un proceso más en la
 * imagen de cada deploy era un roster que se desincroniza de la config que lo usa.
 *
 * Un hijo que se cae se relanza; cinco caídas rápidas seguidas (< 10 s) y se deja caído: un MCP es
 * opcional (el agente que lo nombra corre sin él) y no vale tirar abajo los webhooks por uno.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { interpolate } from './mcpCatalog.js'

export const McpHostEntrySchema = z.strictObject({
  /** El proceso: `[bin, ...args]`, buscado en el PATH. */
  command: z.array(z.string().min(1)).min(1),
  /** Dónde escucha el proceso (loopback): la URL a la que se reenvía `/mcp/<id>[/resto]`. */
  upstream: z.url(),
  /** El bearer que se le exige a quien llama, con `${VAR}` del ambiente. Sin él resuelto, la ruta
   *  responde 503 y el proceso no se levanta: falla cerrada, nunca abierta. */
  token: z.string().min(1),
  /** Env extra del proceso (con `${VAR}`), sobre el del runner. */
  env: z.record(z.string(), z.string()).optional(),
})
export type McpHostEntry = z.infer<typeof McpHostEntrySchema>

export const MCP_HOST_PREFIX = '/mcp/'
/** Menos que esto corriendo, la salida cuenta como caída rápida (un flag inválido, un bin que no
 *  está), no como un blip. */
const FAST_EXIT_MS = 10_000
const MAX_FAST_EXITS = 5
const RESTART_DELAY_MS = 5_000

export interface McpHostOptions {
  log: (line: string) => void
  /** Tests: cómo se lanza un proceso (default `Bun.spawn`). */
  spawn?: (
    command: string[],
    env: Record<string, string | undefined>,
  ) => { exited: Promise<number>; kill(): void }
  restartDelayMs?: number
}

export interface McpHost {
  /** Los ids publicados (con su token resuelto). */
  ids: string[]
  /** La URL local de un MCP publicado — para probarlo sin salir por la URL pública. */
  upstreamOf(id: string): string | undefined
  /** Espera (hasta `timeoutMs`) a que cada upstream conteste algo; los que no, siguen sin estar. */
  ready(timeoutMs?: number): Promise<void>
  /** El handler del servidor node: `true` si la request era de `/mcp/<id>`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  close(): void
}

function extractBearer(req: IncomingMessage): string | undefined {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  return match?.[1]
}

/** `timingSafeEqual` pide el mismo largo: se comparan los digests (largo fijo), no los valores. */
function tokenMatches(expected: string, actual: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(expected), digest(actual))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Headers que no se reenvían: la credencial es la del runner, y el framing lo arma `fetch`. */
const DROP_REQUEST_HEADERS = new Set([
  'authorization',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
])
const DROP_RESPONSE_HEADERS = new Set(['connection', 'content-length', 'transfer-encoding'])

function send(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error }))
}

async function resolveOptional(template: string): Promise<string | undefined> {
  try {
    return await interpolate(template, async (name) => {
      const value = process.env[name]
      if (value == null || value === '') throw new Error(name)
      return value
    })
  } catch {
    return undefined
  }
}

/** El env del proceso: el del runner más el de su entrada, con `${VAR}` resuelto. */
async function childEnv(entry: McpHostEntry): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const [name, template] of Object.entries(entry.env ?? {})) {
    env[name] = (await resolveOptional(template)) ?? template
  }
  return env
}

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2_000) })
    await res.body?.cancel()
    return true
  } catch {
    return false
  }
}

/** La request, hacia el proceso: sin la credencial del runner y con el body bufferizado (un
 *  JSON-RPC es chico; GET/HEAD no llevan — el GET abre el SSE). */
async function forward(req: IncomingMessage, target: string): Promise<Response> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string' && !DROP_REQUEST_HEADERS.has(name)) headers.set(name, value)
  }
  const method = req.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)
  return fetch(target, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) })
}

/** La respuesta del proceso, EN STREAM: Streamable HTTP puede contestar un SSE que dura toda la
 *  sesión, y bufferizarlo la colgaría. */
function pipeResponse(upstream: Response, res: ServerResponse): void {
  const headers: Record<string, string> = {}
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE_HEADERS.has(name)) headers[name] = value
  })
  res.writeHead(upstream.status, headers)
  if (!upstream.body) {
    res.end()
    return
  }
  const stream = Readable.fromWeb(
    upstream.body as unknown as import('node:stream/web').ReadableStream,
  )
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

export async function startMcpHost(
  entries: Record<string, McpHostEntry>,
  opts: McpHostOptions,
): Promise<McpHost> {
  const spawn =
    opts.spawn ??
    ((command, env) => Bun.spawn(command, { env, stdout: 'inherit', stderr: 'inherit' }))
  const restartDelayMs = opts.restartDelayMs ?? RESTART_DELAY_MS
  const published = new Map<string, { entry: McpHostEntry; token: string }>()
  const running = new Map<string, { kill(): void }>()
  let closed = false

  for (const [id, entry] of Object.entries(entries)) {
    const token = await resolveOptional(entry.token)
    if (!token) {
      opts.log(`→ aviso: mcpHost "${id}" sin token (${entry.token}) — no se levanta y responde 503`)
      continue
    }
    published.set(id, { entry, token })
  }

  /** Una corrida del proceso, hasta que sale: su código (-1 si ni arrancó). */
  async function runOnce(id: string, command: string[], env: Record<string, string | undefined>) {
    try {
      const child = spawn(command, env)
      running.set(id, child)
      return await child.exited
    } catch (err) {
      opts.log(`mcpHost "${id}": no arrancó (${(err as Error).message})`)
      return -1
    } finally {
      running.delete(id)
    }
  }

  /** Relanza el proceso hasta que lo cierren o caiga rápido MAX_FAST_EXITS veces seguidas. */
  async function supervise(id: string, entry: McpHostEntry): Promise<void> {
    const env = await childEnv(entry)
    let fastExits = 0
    while (!closed && fastExits < MAX_FAST_EXITS) {
      const startedAt = Date.now()
      const code = await runOnce(id, entry.command, env)
      if (closed) return
      const elapsed = Date.now() - startedAt
      fastExits = elapsed < FAST_EXIT_MS ? fastExits + 1 : 0
      opts.log(
        `mcpHost "${id}" salió (exit ${code}, corrió ${Math.round(elapsed / 1000)}s, caídas rápidas seguidas=${fastExits})`,
      )
      await new Promise((resolve) => setTimeout(resolve, restartDelayMs))
    }
    if (!closed) {
      opts.log(
        `mcpHost "${id}": ${MAX_FAST_EXITS} caídas rápidas seguidas, queda caído — el runner sigue sin él`,
      )
    }
  }

  for (const [id, { entry }] of published) {
    void supervise(id, entry)
    opts.log(`→ mcpHost: ${MCP_HOST_PREFIX}${id} → ${entry.upstream} (${entry.command[0]})`)
  }

  /** Los ids que todavía no contestan (una pasada). */
  async function stillDown(pending: Set<string>): Promise<void> {
    for (const id of [...pending]) {
      const upstream = published.get(id)?.entry.upstream
      if (upstream && (await answers(upstream))) pending.delete(id)
    }
  }

  /** El MCP de la ruta y si quien llama trae su bearer; si no, ya se respondió el rechazo. */
  function authorize(id: string | undefined, req: IncomingMessage, res: ServerResponse) {
    if (!id || !(id in entries)) return send(res, 404, 'not found')
    const server = published.get(id)
    if (!server) return send(res, 503, `mcp "${id}" sin token configurado`)
    const actual = extractBearer(req)
    if (!actual || !tokenMatches(server.token, actual)) return send(res, 401, 'unauthorized')
    return server
  }

  return {
    ids: [...published.keys()],
    upstreamOf: (id) => published.get(id)?.entry.upstream,
    async ready(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs
      const pending = new Set(published.keys())
      while (pending.size > 0 && Date.now() < deadline && !closed) {
        await stillDown(pending)
        if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 250))
      }
      for (const id of pending) opts.log(`→ aviso: mcpHost "${id}" no contestó al arrancar`)
    },
    async handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(MCP_HOST_PREFIX)) return false
      const match = /^\/mcp\/([^/]+)(\/.*)?$/.exec(url.pathname)
      const server = authorize(match?.[1], req, res)
      if (!server) return true
      try {
        pipeResponse(
          await forward(req, `${server.entry.upstream}${match?.[2] ?? ''}${url.search}`),
          res,
        )
      } catch (err) {
        send(res, 502, `mcp "${match?.[1]}" no responde (${(err as Error).message})`)
      }
      return true
    },
    close() {
      closed = true
      for (const child of running.values()) child.kill()
      running.clear()
    },
  }
}
