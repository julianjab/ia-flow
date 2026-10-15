/**
 * Un cliente MCP mínimo sobre Streamable HTTP: `initialize`, `tools/list` y `tools/call`. Es lo
 * que el provider necesita para hablarle a un MCP él mismo, sin el conector de Anthropic
 * (`mcp_servers`), que desde 2026-10-15 rechaza los tokens OAuth de una suscripción de Claude Code.
 *
 * Una respuesta puede venir como JSON o como un stream SSE con el mensaje JSON-RPC adentro; el
 * servidor puede abrir una sesión (`Mcp-Session-Id`), que se reenvía en cada request.
 */
import type { McpAuthorizationToken } from './AnthropicProvider.js'

/** La versión del protocolo que se negocia en `initialize`. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

export interface McpHttpClientOptions {
  url: string
  /** El bearer del servidor: fijo, o resuelto en cada request (un installation token vence). */
  authorizationToken?: McpAuthorizationToken
  fetchImpl?: typeof fetch
  clientInfo?: { name: string; version: string }
}

/** Una tool tal como la lista el servidor. */
export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** Lo que devolvió un `tools/call`, aplanado a texto para un `tool_result`. */
export interface McpCallResult {
  text: string
  isError: boolean
}

/** Un error del transporte o del protocolo (no el `isError` de una tool, que es un resultado). */
export class McpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpError'
  }
}

interface JsonRpcMessage {
  id?: number | string
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

const PREVIEW_CHARS = 300

export class McpHttpClient {
  private sessionId: string | undefined
  private nextId = 1
  private initialized: Promise<void> | undefined

  constructor(private readonly options: McpHttpClientOptions) {}

  /** Todas las tools del servidor, siguiendo la paginación (`nextCursor`). */
  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    do {
      const result = await this.call('tools/list', cursor ? { cursor } : {})
      tools.push(...((result.tools as McpToolInfo[] | undefined) ?? []))
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined
    } while (cursor)
    return tools
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const result = await this.call('tools/call', { name, arguments: args ?? {} })
    return { text: contentText(result), isError: result.isError === true }
  }

  /** Un método con la sesión lista. Si el servidor olvidó la sesión (404), se abre otra una vez. */
  private async call(method: string, params: Record<string, unknown>) {
    await this.ready()
    try {
      return await this.request(method, params)
    } catch (err) {
      if (!(err instanceof SessionExpired)) throw err
      this.reset()
      await this.ready()
      return this.request(method, params)
    }
  }

  private ready(): Promise<void> {
    this.initialized ??= this.initialize().catch((err) => {
      this.reset()
      throw err
    })
    return this.initialized
  }

  private reset(): void {
    this.initialized = undefined
    this.sessionId = undefined
  }

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.options.clientInfo ?? { name: 'ia-flow', version: '0' },
    })
    const res = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await res.body?.cancel()
    if (!res.ok) throw new McpError(`notifications/initialized → HTTP ${res.status}`)
  }

  private async request(method: string, params: Record<string, unknown>) {
    const id = this.nextId++
    const res = await this.post({ jsonrpc: '2.0', id, method, params })
    if (res.status === 404 && this.sessionId && method !== 'initialize') {
      await res.body?.cancel()
      throw new SessionExpired()
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, PREVIEW_CHARS)
      throw new McpError(`${method} → HTTP ${res.status}${body ? `: ${body}` : ''}`)
    }
    const session = res.headers.get('mcp-session-id')
    if (session) this.sessionId = session
    const message = await readMessage(res, id)
    if (message.error) {
      throw new McpError(`${method}: ${message.error.message ?? `error ${message.error.code}`}`)
    }
    return message.result ?? {}
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    const { authorizationToken, fetchImpl = fetch, url } = this.options
    const token =
      typeof authorizationToken === 'function' ? await authorizationToken() : authorizationToken
    return fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...(this.initialized ? { 'mcp-protocol-version': MCP_PROTOCOL_VERSION } : {}),
      },
      body: JSON.stringify(body),
    })
  }
}

class SessionExpired extends Error {}

/** La respuesta al request `id`: el body JSON, o el evento SSE que la trae. */
async function readMessage(res: Response, id: number): Promise<JsonRpcMessage> {
  const type = res.headers.get('content-type') ?? ''
  const text = await res.text()
  if (!type.includes('text/event-stream')) return parseMessage(text)
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
    if (!data) continue
    const message = parseMessage(data)
    if (message.id === id) return message
  }
  throw new McpError(`el stream no trajo la respuesta al request ${id}`)
}

function parseMessage(text: string): JsonRpcMessage {
  try {
    return JSON.parse(text) as JsonRpcMessage
  } catch {
    throw new McpError(`respuesta que no es JSON-RPC: ${text.slice(0, PREVIEW_CHARS)}`)
  }
}

interface ContentPart {
  type?: string
  text?: string
  mimeType?: string
  resource?: { uri?: string; text?: string }
}

/** El `content` de un `tools/call` como texto: el modelo lee un `tool_result` de texto. */
function contentText(result: Record<string, unknown>): string {
  const parts = Array.isArray(result.content) ? (result.content as ContentPart[]) : []
  const text = parts
    .map((part) => {
      if (part.type === 'text') return part.text ?? ''
      if (part.type === 'resource') return part.resource?.text ?? part.resource?.uri ?? ''
      if (part.type === 'image' || part.type === 'audio')
        return `[${part.type} ${part.mimeType ?? ''}]`
      return JSON.stringify(part)
    })
    .filter(Boolean)
    .join('\n')
  if (text) return text
  return result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : ''
}
