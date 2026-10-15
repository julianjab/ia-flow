/** Un servidor MCP falso detrás de un `fetch` inyectable: Streamable HTTP con sesión, para probar
 *  el cliente sin red. Anota cada request (método JSON-RPC + headers) para que el test los mire. */

export interface FakeTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** El `result` de un `tools/call`; si tira, el servidor responde un error JSON-RPC. */
  call?: (args: Record<string, unknown>) => Record<string, unknown>
}

export interface FakeMcpOptions {
  tools: FakeTool[]
  /** Tools por página de `tools/list` (para probar `nextCursor`). Default: todas en una. */
  pageSize?: number
  /** Responder en SSE en vez de JSON. */
  sse?: boolean
  /** El bearer que exige (401 si no coincide). */
  token?: string
  /** El status de `initialize` (para simular un servidor caído). */
  initializeStatus?: number
}

export interface SeenRequest {
  method: string
  headers: Record<string, string>
  params?: Record<string, unknown>
}

interface RpcBody {
  id?: unknown
  method: string
  params?: Record<string, unknown>
}

export function fakeMcpServer(options: FakeMcpOptions) {
  const seen: SeenRequest[] = []
  let session = 0
  let live: string | undefined

  const reply = (
    id: unknown,
    payload: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => {
    const message = JSON.stringify({ jsonrpc: '2.0', id, ...payload })
    if (options.sse) {
      return new Response(`event: message\ndata: ${message}\n\n`, {
        headers: { 'content-type': 'text/event-stream', ...headers },
      })
    }
    return new Response(message, { headers: { 'content-type': 'application/json', ...headers } })
  }

  const initialize = (body: RpcBody) => {
    if (options.initializeStatus) return new Response('down', { status: options.initializeStatus })
    live = `s${++session}`
    const result = { protocolVersion: '2025-06-18', capabilities: {} }
    return reply(body.id, { result }, { 'mcp-session-id': live })
  }

  const listTools = (body: RpcBody) => {
    const size = options.pageSize ?? options.tools.length
    const start = Number(body.params?.cursor ?? 0)
    const page = options.tools.slice(start, start + size).map(({ call: _c, ...tool }) => ({
      inputSchema: { type: 'object', properties: {} },
      ...tool,
    }))
    const next = start + size < options.tools.length ? String(start + size) : undefined
    return reply(body.id, { result: { tools: page, ...(next ? { nextCursor: next } : {}) } })
  }

  const callTool = (body: RpcBody) => {
    const tool = options.tools.find((t) => t.name === body.params?.name)
    if (!tool?.call) return reply(body.id, { error: { code: -32602, message: 'unknown tool' } })
    try {
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>
      return reply(body.id, { result: tool.call(args) })
    } catch (err) {
      return reply(body.id, { error: { code: -32000, message: (err as Error).message } })
    }
  }

  const methods: Record<string, (body: RpcBody) => Response> = {
    'notifications/initialized': () => new Response(null, { status: 202 }),
    'tools/list': listTools,
    'tools/call': callTool,
  }

  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const body = JSON.parse(String(init?.body)) as RpcBody
    seen.push({ method: body.method, headers, ...(body.params ? { params: body.params } : {}) })

    if (options.token && headers.authorization !== `Bearer ${options.token}`) {
      return new Response('unauthorized', { status: 401 })
    }
    if (body.method === 'initialize') return initialize(body)
    if (headers['mcp-session-id'] !== live) return new Response('no session', { status: 404 })
    const method = methods[body.method]
    return method
      ? method(body)
      : reply(body.id, { error: { code: -32601, message: 'method not found' } })
  }) as typeof fetch

  return {
    fetchImpl,
    seen,
    /** Simula que el servidor reinició y olvidó la sesión. */
    forgetSession: () => {
      live = undefined
    },
  }
}
