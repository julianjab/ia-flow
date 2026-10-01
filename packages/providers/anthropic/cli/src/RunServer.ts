import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ChannelRouter, type RunChannel } from '@ia-flow/provider-shared'
import { createLogger } from '@ia-flow/telemetry'

/** Dónde le habla una sesión del CLI al runner. */
export interface RunEndpoints {
  /** El MCP de la corrida (`--mcp-config`). */
  mcp: string
  /** Un hook: `<hooks>/<Evento>` (`--settings`). */
  hooks: string
}

const MAX_BODY = 5 * 1024 * 1024

/**
 * El servidor HTTP local de las sesiones del CLI: `POST /mcp/<token>` (las tools de la corrida) y
 * `POST /hooks/<token>/<Evento>` (los hooks de Claude Code). Escucha en `127.0.0.1`, en un puerto
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

  /** Registra la corrida y devuelve sus URLs. */
  async open(channel: RunChannel): Promise<RunEndpoints> {
    const base = await this.start()
    this.router.open(channel)
    return { mcp: `${base}/mcp/${channel.token}`, hooks: `${base}/hooks/${channel.token}` }
  }

  close(channel: RunChannel): void {
    this.router.close(channel)
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
    const [, kind, token, event] = (req.url ?? '').split('?')[0]?.split('/') ?? []
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
