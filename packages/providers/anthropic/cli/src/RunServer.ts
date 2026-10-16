import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServerRef } from '@ia-flow/agent-engine'
import { ChannelRouter, type RunChannel } from '@ia-flow/provider-shared'
import { createLogger } from '@ia-flow/telemetry'
import { forwardToUpstream, type McpUpstream, refreshableUpstreams } from './McpUpstream.js'

/** Dónde le habla una sesión del CLI al runner. */
export interface RunEndpoints {
  /** El MCP de la corrida (`--mcp-config`). */
  mcp: string
  /** Un hook: `<hooks>/<Evento>` (`--settings`). */
  hooks: string
  /** Un MCP externo con token renovable: `<upstream>/<id>` (ver `McpUpstream`). */
  upstream: string
  /** Los ids que pasan por `upstream`. */
  upstreams: string[]
}

const MAX_BODY = 5 * 1024 * 1024

/**
 * El servidor HTTP local de las sesiones del CLI: `POST /mcp/<token>` (las tools de la corrida),
 * `POST /hooks/<token>/<Evento>` (los hooks de Claude Code) y `/upstream/<token>/<id>` (un MCP
 * externo con el token del momento, ver `McpUpstream`). Escucha en `127.0.0.1`, en un puerto
 * efímero, y arranca con la primera corrida: no depende del servidor del runner, así que sirve
 * también cuando el runner corre un evento suelto. Un token por corrida — muere al cerrarla. Qué
 * contesta cada ruta lo decide el `ChannelRouter` (`@ia-flow/provider-shared`); esto es el
 * transporte.
 */
export class RunServer {
  readonly log = createLogger('provider-anthropic-cli')
  private server: Server | undefined
  private listening: Promise<string> | undefined
  private readonly router = new ChannelRouter()
  private readonly upstreams = new Map<string, Map<string, McpUpstream>>()

  /** `fetchImpl`: tests (hacia los MCP externos). */
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Registra la corrida (y los MCP del agente que pasan por acá) y devuelve sus URLs. */
  async open(channel: RunChannel, mcpServers: McpServerRef[] = []): Promise<RunEndpoints> {
    const base = await this.start()
    this.router.open(channel)
    const upstreams = refreshableUpstreams(mcpServers)
    this.upstreams.set(channel.token, upstreams)
    return {
      mcp: `${base}/mcp/${channel.token}`,
      hooks: `${base}/hooks/${channel.token}`,
      upstream: `${base}/upstream/${channel.token}`,
      upstreams: [...upstreams.keys()],
    }
  }

  close(channel: RunChannel): void {
    this.router.close(channel)
    this.upstreams.delete(channel.token)
  }

  /** Apaga el servidor (tests, o el runner al salir). */
  stop(): void {
    this.server?.close()
    this.server = undefined
    this.listening = undefined
  }

  private start(): Promise<string> {
    this.listening ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.route(req, res).catch((error) => {
          this.log.error(`servidor local: ${(error as Error).message}`)
          if (!res.headersSent) send(res, 500, { error: 'error interno' })
        })
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.unref()
        const { port } = server.address() as AddressInfo
        resolve(`http://127.0.0.1:${port}`)
      })
      this.server = server
    })
    return this.listening
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [path = '', query] = (req.url ?? '').split('?')
    const [, kind, token, event, ...rest] = path.split('/')
    if (kind === 'upstream') {
      await this.proxy(req, res, token ?? '', event ?? '', rest, query)
      return
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'sólo POST' })
      return
    }
    const reply = await this.router.handle(kind ?? '', token ?? '', event, await readJson(req))
    if (reply.body === null) {
      res.writeHead(reply.status).end()
      return
    }
    send(res, reply.status, reply.body)
  }

  private async proxy(
    req: IncomingMessage,
    res: ServerResponse,
    token: string,
    id: string,
    rest: string[],
    query: string | undefined,
  ): Promise<void> {
    const upstream = this.upstreams.get(token)?.get(decodeURIComponent(id))
    if (!upstream) {
      send(res, 404, { error: 'MCP desconocido para esta corrida' })
      return
    }
    const suffix = (rest.length > 0 ? `/${rest.join('/')}` : '') + (query ? `?${query}` : '')
    const status = await forwardToUpstream(req, res, upstream, suffix, this.fetchImpl)
    if (status === 401) this.log.warn(`MCP ${id}: rechazó también el token renovado (401)`)
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('body demasiado grande')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  return text ? JSON.parse(text) : {}
}
