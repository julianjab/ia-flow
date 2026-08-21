import { resolveExecutableTool, resolveTools } from '@ia-flow/tools'
import { Hono } from 'hono'
import { createLogger } from '../logger.js'
import { buildToolContext } from './tools.js'

// MCP endpoint wrapping the same tool registry POST /api/tools/:name uses —
// gives both anthropic-api (native tools:) and the terminal providers
// (--mcp-config) a validated tool_use call instead of the terminal path's
// old free-text curl appendix. Minimal hand-rolled JSON-RPC 2.0 over a
// single POST/response (Streamable HTTP, stateless — no SSE, no session
// id): the tool surface here is 4 methods, not worth pulling in the full
// @modelcontextprotocol/sdk (which expects Node's http.IncomingMessage/
// ServerResponse, not Hono's Fetch-based Request/Response).
//
// Scoping: the caller (terminal/base.ts) bakes the agent's allowed tool
// names into the URL as `?tools=a,b,c` — MCP's `tools/list` has no per-call
// argument to carry that, so it has to travel on the connection itself.
// Every agent with `tools[]` gets its own URL, same as it gets its own
// curl-appendix content today.

const log = createLogger('mcp-route')

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, result }
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } }
}

export function createMcpRouter() {
  const app = new Hono()

  app.post('/', async (c) => {
    let body: JsonRpcRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'), 400)
    }

    const { id, method, params } = body
    const toolNamesParam = c.req.query('tools')
    const toolNames = toolNamesParam ? toolNamesParam.split(',').filter(Boolean) : undefined

    switch (method) {
      case 'initialize':
        return c.json(
          rpcResult(id, {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'ia-flow-tools', version: '1.0.0' },
          }),
        )

      // Notification — client doesn't expect a JSON-RPC response body.
      case 'notifications/initialized':
        return c.body(null, 202)

      case 'tools/list': {
        const tools = resolveTools({ providerKind: 'async', toolNames }).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.input_schema,
        }))
        return c.json(rpcResult(id, { tools }))
      }

      case 'tools/call': {
        const name = params?.name as string | undefined
        const args = (params?.arguments as unknown) ?? {}
        if (!name) return c.json(rpcError(id, -32602, 'Missing tool name'))

        // Same rules `tools/list` used to decide what's *offered* — re-applied
        // here so a client can't call a tool it was never handed just by
        // naming it (async-only tools, or ones outside this connection's
        // `?tools=` allow-list). See resolveExecutableTool's doc.
        const ctx = {
          ...buildToolContext(),
          providerKind: 'async' as const,
          policy: toolNames ? { toolNames: new Set(toolNames) } : undefined,
        }
        const tool = resolveExecutableTool(name, ctx)
        if (!tool) {
          return c.json(
            rpcResult(id, {
              content: [{ type: 'text', text: `Tool '${name}' not found` }],
              isError: true,
            }),
          )
        }

        log.debug({ tool: name, args }, 'mcp tool call')
        try {
          const result = await tool.execute(args, ctx)
          return c.json(rpcResult(id, { content: [{ type: 'text', text: result }] }))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn({ tool: name, err: msg }, 'mcp tool call failed')
          return c.json(rpcResult(id, { content: [{ type: 'text', text: msg }], isError: true }))
        }
      }

      default:
        return c.json(rpcError(id, -32601, `Method not found: ${method}`), 404)
    }
  })

  return app
}
