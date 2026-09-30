import { MCP_SERVER_NAME, type RunChannel } from './RunChannel.js'

/** Lo que contesta el servidor: `body: null` = sin cuerpo (una notificación). */
export interface McpReply {
  status: number
  body: unknown
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

const DEFAULT_PROTOCOL = '2025-06-18'

/**
 * El MCP de una corrida, sin transporte: entra el body JSON-RPC ya parseado, sale el status y la
 * respuesta. Es un servidor de tools y nada más — `initialize`, `ping`, `tools/list`,
 * `tools/call`; las notificaciones se aceptan sin cuerpo. Streamable HTTP permite contestar con
 * JSON plano, así que no hay SSE.
 */
export async function handleMcp(channel: RunChannel, body: unknown): Promise<McpReply> {
  if (Array.isArray(body)) {
    const replies = await Promise.all(body.map((request) => respond(channel, request)))
    const answered = replies.filter((reply) => reply !== undefined)
    return answered.length > 0 ? { status: 200, body: answered } : { status: 202, body: null }
  }
  const reply = await respond(channel, body)
  return reply === undefined ? { status: 202, body: null } : { status: 200, body: reply }
}

async function respond(channel: RunChannel, raw: unknown): Promise<unknown> {
  const request = (typeof raw === 'object' && raw !== null ? raw : {}) as JsonRpcRequest
  // Sin `id` es una notificación (`notifications/initialized`, …): no se contesta.
  if (request.id === undefined || request.id === null) return undefined
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: request.id, result })
  const fail = (code: number, message: string) => ({
    jsonrpc: '2.0',
    id: request.id,
    error: { code, message },
  })
  switch (request.method) {
    case 'initialize':
      return ok({
        protocolVersion: String(request.params?.protocolVersion ?? DEFAULT_PROTOCOL),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: '1.0.0' },
      })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: channel.listTools() })
    case 'tools/call': {
      const name = request.params?.name
      if (typeof name !== 'string') return fail(-32602, 'tools/call sin `name`')
      const { text, isError } = await channel.call(name, request.params?.arguments)
      return ok({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })
    }
    default:
      return fail(-32601, `método no soportado: ${request.method}`)
  }
}
