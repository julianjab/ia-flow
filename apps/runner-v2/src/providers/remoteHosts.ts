/**
 * Del lado del runner, los hosts remotos (`@ia-flow/provider-remote`): se suscriben a la API del
 * runner (`/v1/hosts/*`, con IA_FLOW_HOST_TOKEN) y aparecen en el `providerRegistry` como
 * `remote:<name>`; cada corrida que toman se espera en su canal (`/v1/runs/<token>/*`). Montado en
 * el mismo puerto que los webhooks: el runner ya es público.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { providerRegistry } from '@ia-flow/agent-engine'
import { RemoteHub } from '@ia-flow/provider-remote'

export function mountRemoteHosts(token = process.env.IA_FLOW_HOST_TOKEN?.trim()): RemoteHub {
  return new RemoteHub({ registry: providerRegistry, token: token || undefined })
}

/** Un handler `fetch` (el del hub) como handler del servidor node de los webhooks: `true` si la
 *  request era suya. */
export function nodeHandler(fetchLike: (req: Request) => Promise<Response | undefined>): {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
} {
  return {
    async handle(req, res) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (!url.pathname.startsWith('/v1/hosts') && !url.pathname.startsWith('/v1/runs')) {
        return false
      }
      const response = await fetchLike(await toRequest(url, req))
      if (!response) return false
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      res.end(Buffer.from(await response.arrayBuffer()))
      return true
    },
  }
}

async function toRequest(url: URL, req: IncomingMessage): Promise<Request> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value)
  }
  const method = req.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers })
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return new Request(url, { method, headers, body: Buffer.concat(chunks) })
}

/** Sólo la API de hosts, en `port`: para un evento suelto (`--event`), donde no hay servidor de
 *  webhooks y un agente con `remote:*` igual necesita que su host lo alcance. */
export async function listenHosts(
  hub: RemoteHub,
  port: number,
  log: (line: string) => void,
): Promise<Server> {
  const api = nodeHandler((req) => hub.fetch(req))
  const server = createServer((req, res) => {
    api
      .handle(req, res)
      .then((handled) => {
        if (!handled) res.writeHead(404).end()
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end()
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve())
  })
  log(`→ hosts: la API de hosts escucha en http://localhost:${port}/v1/hosts`)
  return server
}
