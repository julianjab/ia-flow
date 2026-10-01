/**
 * La API de la web sobre `node:http`, sin framework: rutas con parámetros (`/api/tasks/:owner/…`),
 * CORS para una web servida desde otro origen, y el token del runner (`IA_FLOW_API_TOKEN`) en
 * `x-ia-flow-token`, `Authorization: Bearer` o `?token=` (un EventSource no puede mandar headers).
 * Sin token configurado, toda ruta protegida responde 503: la API mueve cards y dispara agentes,
 * así que falla CERRADA, igual que el webhook sin secreto.
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface ApiRequest {
  method: string
  path: string
  params: Record<string, string>
  query: URLSearchParams
  header(name: string): string | undefined
  /** El body parseado como JSON (vacío: `{}`). */
  json(): Promise<unknown>
  raw: IncomingMessage
}

/** Lo que devuelve un handler va como JSON 200; `undefined`, que ya respondió él (un stream). */
export type ApiHandler = (req: ApiRequest, res: ServerResponse) => Promise<unknown>

/** Un error con su status HTTP: el mensaje llega tal cual a la web. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface Route {
  method: string
  parts: string[]
  handler: ApiHandler
  public: boolean
}

const MAX_BODY_BYTES = 1024 * 1024
const ALLOWED_HEADERS = 'content-type, authorization, x-ia-flow-token, x-github-token'

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

function match(route: Route, method: string, parts: string[]): Record<string, string> | undefined {
  if (route.method !== method || route.parts.length !== parts.length) return undefined
  const params: Record<string, string> = {}
  for (const [index, part] of route.parts.entries()) {
    const actual = parts[index] as string
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(actual)
    else if (part !== actual) return undefined
  }
  return params
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body demasiado grande')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'body JSON inválido')
  }
}

export interface ApiRouterOptions {
  /** `IA_FLOW_API_TOKEN`. Vacío: las rutas protegidas responden 503. */
  token: string | undefined
  log: (line: string) => void
}

export class ApiRouter {
  private readonly routes: Route[] = []
  private readonly token: string | undefined

  constructor(private readonly options: ApiRouterOptions) {
    this.token = options.token?.trim() || undefined
  }

  get(pattern: string, handler: ApiHandler, opts: { public?: boolean } = {}): this {
    return this.add('GET', pattern, handler, opts)
  }

  post(pattern: string, handler: ApiHandler, opts: { public?: boolean } = {}): this {
    return this.add('POST', pattern, handler, opts)
  }

  delete(pattern: string, handler: ApiHandler, opts: { public?: boolean } = {}): this {
    return this.add('DELETE', pattern, handler, opts)
  }

  private add(
    method: string,
    pattern: string,
    handler: ApiHandler,
    opts: { public?: boolean },
  ): this {
    this.routes.push({
      method,
      parts: pattern.split('/').filter(Boolean),
      handler,
      public: opts.public ?? false,
    })
    return this
  }

  private cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin
    if (!origin) return
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'origin')
    res.setHeader('access-control-allow-headers', ALLOWED_HEADERS)
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('access-control-max-age', '600')
  }

  private authorized(req: IncomingMessage, query: URLSearchParams): boolean {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const header = req.headers['x-ia-flow-token']
    const given =
      (Array.isArray(header) ? header[0] : header) ?? bearer ?? query.get('token') ?? undefined
    return this.token !== undefined && given !== undefined && sameToken(given, this.token)
  }

  /** Si la ruta es de la API la atiende y devuelve `true`; si no, deja que siga el servidor
   *  (los webhooks) — ya con CORS puesto si es `/api/*`. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://runner')
    if (!url.pathname.startsWith('/api/')) return false
    this.cors(req, res)
    const method = req.method ?? 'GET'
    if (method === 'OPTIONS') {
      res.writeHead(204).end()
      return true
    }
    const parts = url.pathname.split('/').filter(Boolean)
    for (const route of this.routes) {
      const params = match(route, method, parts)
      if (!params) continue
      await this.run(route, params, url, req, res)
      return true
    }
    return false
  }

  private async run(
    route: Route,
    params: Record<string, string>,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!route.public) {
      if (!this.token) return sendJson(res, 503, { error: 'IA_FLOW_API_TOKEN no está configurado' })
      if (!this.authorized(req, url.searchParams))
        return sendJson(res, 401, { error: 'token inválido' })
    }
    const request: ApiRequest = {
      method: route.method,
      path: url.pathname,
      params,
      query: url.searchParams,
      header: (name) => {
        const value = req.headers[name.toLowerCase()]
        return Array.isArray(value) ? value[0] : value
      },
      json: () => readJson(req),
      raw: req,
    }
    try {
      const body = await route.handler(request, res)
      if (body !== undefined) sendJson(res, 200, body)
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message })
      const message = err instanceof Error ? err.message : String(err)
      this.options.log(`api ${route.method} ${url.pathname}: ${message}`)
      sendJson(res, 500, { error: message })
    }
  }
}
