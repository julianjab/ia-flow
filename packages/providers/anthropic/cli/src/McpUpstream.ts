import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { McpServerRef } from '@ia-flow/agent-engine'
import { resolveMcpToken } from '@ia-flow/provider-shared'

/**
 * Un MCP externo detrás del servidor local de la sesión (`/upstream/<corrida>/<id>`). El CLI lee
 * su `--mcp-config` una vez y se queda con el header que tenga: un installation token de GitHub
 * vence a la hora y una corrida larga perdía el MCP a mitad de camino ("rejected the
 * Authorization header"). Por acá cada request sale con el token del momento y, si el servidor
 * contesta 401, se fuerza uno nuevo y se reintenta una vez.
 */
export interface McpUpstream {
  url: string
  token(force: boolean): Promise<string | undefined>
}

/** Los MCP del agente cuyo token es una función (se puede renovar): los demás no pasan por acá. */
export function refreshableUpstreams(servers: McpServerRef[]): Map<string, McpUpstream> {
  const upstreams = new Map<string, McpUpstream>()
  for (const { id, config } of servers) {
    const raw = config.authorizationToken
    if (typeof config.url !== 'string' || typeof raw !== 'function') continue
    upstreams.set(id, { url: config.url, token: (force) => resolveMcpToken(raw, force) })
  }
  return upstreams
}

/** Headers que no se reenvían: la credencial la pone el proxy y el framing lo arma `fetch`. */
const DROP_REQUEST = new Set([
  'host',
  'authorization',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
])
/** `fetch` ya descomprimió el body: su largo y su encoding de origen no aplican. */
const DROP_RESPONSE = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
])

/** Reenvía `req` a `upstream` (más `rest`, lo que venga después del id) y devuelve el status. */
export async function forwardToUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: McpUpstream,
  rest: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
  // Un GET de MCP es un stream SSE largo: si el CLI se va, se corta también hacia el servidor.
  const abort = new AbortController()
  res.once('close', () => abort.abort())
  const send = async (force: boolean) => {
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROP_REQUEST.has(name)) continue
      headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    const token = await upstream.token(force)
    if (token) headers.set('authorization', `Bearer ${token}`)
    return fetchImpl(upstream.url + rest, {
      method: req.method ?? 'POST',
      headers,
      ...(body ? { body } : {}),
      signal: abort.signal,
    })
  }
  let reply = await send(false)
  if (reply.status === 401) {
    await reply.body?.cancel()
    reply = await send(true)
  }
  const headers: Record<string, string> = {}
  reply.headers.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name)) headers[name] = value
  })
  res.writeHead(reply.status, headers)
  if (!reply.body) {
    res.end()
  } else {
    Readable.fromWeb(reply.body as unknown as NodeReadableStream).pipe(res)
  }
  return reply.status
}

async function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return new Uint8Array(Buffer.concat(chunks))
}
