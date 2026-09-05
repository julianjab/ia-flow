import { selectableExits } from '@ia-flow/agent-engine'
import type { ToolDefinitionsOptions } from '@ia-flow/tools'
import { resolveExecutableTool, resolveTools } from '@ia-flow/tools'
import { Hono } from 'hono'
import { configRepo } from '../composition/container.js'
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
    if (typeof method !== 'string' || !method) {
      return c.json(rpcError(id, -32600, 'Invalid Request: falta `method`'), 400)
    }
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

      // Keep-alive del transporte. Responde `{}` — no tiene contenido, pero
      // un cliente que lo manda espera un result, no un error.
      case 'ping':
        return c.json(rpcResult(id, {}))

      case 'tools/list': {
        // Las tools que se ESPECIALIZAN por agente (`select_exit`,
        // `submit_output`) necesitan la config del agente, no sólo su lista de
        // nombres. En sync la trae el `ProviderInput`; acá hay que ir a
        // buscarla con el `?agent=`/`?project=` que ya viaja en la conexión.
        //
        // Sin esto, `specialize` recibía `undefined` y `hideWhen` escondía la
        // tool: `select_exit` sencillamente NO EXISTÍA para un agente de
        // terminal, aunque su definición declarara salidas elegibles.
        const perAgent = await agentToolOptions(c.req.query('agent'), c.req.query('project'))
        const tools = resolveTools({ providerKind: 'async', toolNames, ...perAgent }).map((t) => ({
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
          ...buildToolContext(c.req.query('project')),
          providerKind: 'async' as const,
          policy: toolNames ? { toolNames: new Set(toolNames) } : undefined,
          // Qué EJECUCIÓN está hablando. Igual que `tools`, viaja en la
          // conexión porque MCP no tiene un argumento por llamada donde
          // colgarlo. Los tools de cierre lo usan para no pisar un run más
          // nuevo de la misma tarea con el cierre tardío de uno viejo.
          runId: c.req.query('run'),
          // Namespace de las tools `memory_*`. Viaja en la conexión, igual
          // que `tools` y `run`, y NO como argumento de la llamada: es lo que
          // impide que un agente lea o escriba la memoria de otro nombrándola.
          agentId: c.req.query('agent'),
          projectId: c.req.query('project'),
          // Mismo canal que `run`/`agent`/`project`: las tools de cierre de
          // `task.ts` lo usan como fallback cuando el modelo no transcribe
          // `task_id` (ver `ToolContext.taskId`, ya poblado del lado sync).
          taskId: c.req.query('task'),
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
        // Notificaciones (`notifications/*`, y cualquier request sin `id`): el
        // cliente no espera cuerpo de respuesta y JSON-RPC prohíbe contestarle
        // un error. Un 404 acá era el "HTTP 404 dialing …/api/mcp" con el que
        // el CLI daba por muerta la conexión entera apenas mandaba una
        // notificación que no fuera `notifications/initialized`.
        if (method.startsWith('notifications/') || id === undefined || id === null) {
          return c.body(null, 202)
        }
        // Método desconocido = error de JSON-RPC, no de HTTP: el transporte
        // funcionó. Un 404 hace que el cliente descarte el body y reporte un
        // fallo de conexión en vez del `-32601`.
        log.debug({ method }, 'mcp: método no soportado')
        return c.json(rpcError(id, -32601, `Method not found: ${method}`))
    }
  })

  // El POST no es el único método del transporte. Un cliente Streamable HTTP
  // (`"type": "http"`, que es como viaja `ia-flow-tools`) abre primero un GET
  // para el stream SSE del server, y cierra con un DELETE. Sin rutas para
  // esos dos métodos caían en el 404 default de Hono, y el CLI daba la
  // conexión entera por muerta —"HTTP 404 dialing …/api/mcp"— antes de llegar
  // a `tools/list`: el agente arrancaba sin NINGUNA tool.
  //
  // 405 y no 404 en el GET porque es lo que la spec define como "no ofrezco
  // stream": el cliente sigue con POSTs, que es todo lo que necesita. Un 404
  // dice "este endpoint no existe", que es otra cosa.
  app.get('/', (c) => c.json(rpcError(null, -32601, 'SSE stream no soportado'), 405))
  // El DELETE cierra una sesión, y acá no hay ninguna que cerrar (el
  // transporte es stateless: no emitimos `Mcp-Session-Id`). Se acepta sin
  // cuerpo en vez de rechazar — el cliente está terminando, no pidiendo algo.
  app.delete('/', (c) => c.body(null, 204))

  return app
}

/**
 * Lo que las tools especializadas por agente necesitan saber de él.
 *
 * Devuelve vacío ante cualquier tropiezo (sin `?agent=`, proyecto que no
 * resuelve, agente que ya no está en el roster): el resultado es que esas
 * tools no se ofrecen, que es exactamente el comportamiento de un agente que
 * no declara nada. Fallar la conexión MCP entera por esto dejaría al agente
 * sin NINGUNA tool.
 */
async function agentToolOptions(
  agentId: string | undefined,
  projectId: string | undefined,
): Promise<Pick<ToolDefinitionsOptions, 'selectableExits' | 'outputFields'>> {
  if (!agentId) return {}
  try {
    const config = await configRepo.getConfig(projectId)
    const agent = (config?.agents ?? []).find((a) => a.id === agentId)
    if (!agent) return {}
    return { selectableExits: selectableExits(agent.exits), outputFields: agent.output }
  } catch (err) {
    log.warn(
      { agentId, projectId, err: (err as Error).message },
      'no se pudo resolver el agente para especializar sus tools — se ofrecen sin especializar',
    )
    return {}
  }
}
