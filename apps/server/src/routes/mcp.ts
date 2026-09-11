import { selectableExits } from '@ia-flow/agent-engine'
import type {
  JsonRpcRequest,
  McpConnection,
  McpResponse,
  ToolDefinitionsOptions,
} from '@ia-flow/tools'
import { handleMcpRequest, mcpNoStream, mcpParseError } from '@ia-flow/tools'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { configRepo } from '../composition/container.js'
import { createLogger } from '../logger.js'
import { buildToolContext } from './tools.js'

// El endpoint MCP del daemon — el mismo registry que usa POST /api/tools/:name.
// Le da a los providers de terminal (`--mcp-config`) un tool_use validado en
// vez del viejo apéndice de curl en texto libre.
//
// La mecánica del protocolo NO vive acá: es `handleMcpRequest`
// (`@ia-flow/tools`), compartida con el `/v1/mcp` del agent-host. Lo de este
// archivo es lo que sólo el daemon puede aportar — el `ToolContext` con sus
// repos y la especialización por agente contra el roster.
//
// Scoping: el cliente (terminal/base.ts) hornea los nombres permitidos del
// agente en la URL como `?tools=a,b,c` — `tools/list` no tiene un argumento
// por llamada donde llevarlos, así que viajan en la conexión.

const log = createLogger('mcp-route')

/** Lo que viaja en la query de la conexión. */
function connectionOf(c: Context): McpConnection {
  const toolNamesParam = c.req.query('tools')
  return {
    toolNames: toolNamesParam ? toolNamesParam.split(',').filter(Boolean) : undefined,
    runId: c.req.query('run'),
    agentId: c.req.query('agent'),
    projectId: c.req.query('project'),
    taskId: c.req.query('task'),
  }
}

function send(c: Context, res: McpResponse) {
  if (res.body === null) return c.body(null, res.status as 202 | 204)
  return c.json(res.body, res.status as 200 | 400 | 405)
}

export function createMcpRouter() {
  const app = new Hono()

  app.post('/', async (c) => {
    let body: JsonRpcRequest
    try {
      body = await c.req.json()
    } catch {
      return send(c, mcpParseError())
    }
    return send(
      c,
      await handleMcpRequest(body, connectionOf(c), {
        serverName: 'ia-flow-tools',
        agentOptions: (conn) => agentToolOptions(conn.agentId, conn.projectId),
        buildContext: (conn) => buildToolContext(conn.projectId),
      }),
    )
  })

  // El POST no es el único método del transporte: un cliente Streamable HTTP
  // abre primero un GET para el stream SSE y cierra con un DELETE. Sin rutas
  // para esos dos caían en el 404 default de Hono y el CLI daba la conexión
  // entera por muerta —"HTTP 404 dialing …/api/mcp"— antes de llegar a
  // `tools/list`: el agente arrancaba sin NINGUNA tool.
  app.get('/', (c) => send(c, mcpNoStream()))
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
