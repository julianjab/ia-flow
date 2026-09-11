// El servidor MCP del registry de tools, sin transporte.
//
// ── Por qué vive acá y no en una ruta ─────────────────────────────────────
//
// Hay DOS procesos que tienen que servir el mismo protocolo sobre el mismo
// registry: el daemon (`/api/mcp`) y el agent-host (`/v1/mcp`). Lo que cambia
// entre ellos no es el JSON-RPC —es idéntico— sino qué tools ofrecen y con qué
// `ToolContext` las ejecutan: el daemon tiene la fuente de issues y el roster
// de agentes, el agent-host tiene el disco donde está el workspace del run.
//
// Copiar la ruta habría duplicado el manejo de `notifications/*`, los códigos
// de error y el 405 del GET —cada uno de esos es un bug ya pagado (ver los
// comentarios de cada handler)— y las dos copias habrían divergido en el
// primer arreglo. Así que la mecánica del protocolo es esto, y cada app pone
// su Hono alrededor.
//
// Sin dependencia de HTTP a propósito: entra un body ya parseado más los
// parámetros de la conexión, sale un `{ status, body }`. Es lo que permite
// testear el protocolo sin levantar un server, y lo que mantiene a
// `@ia-flow/tools` sin Hono.
import type { ProviderKind } from '@ia-flow/ai-providers'
import type { Tool, ToolContext, ToolDefinitionsOptions } from '../contract.js'
import { resolveExecutableTool, resolveTools } from '../engine.js'
import { createLogger } from '../logger.js'

const log = createLogger('mcp-server')

export interface JsonRpcRequest {
  jsonrpc?: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

type JsonRpcId = JsonRpcRequest['id']

export interface McpResponse {
  status: number
  /** `null` = respuesta sin cuerpo (202/204). */
  body: unknown
}

/**
 * Lo que viaja en la CONEXIÓN, no en la llamada.
 *
 * MCP no tiene dónde colgar contexto por invocación, así que el cliente lo
 * pone en la query de la URL y el server lo lee una vez. Es también lo que
 * hace imposible que un agente nombre la memoria de otro: `agentId` no es un
 * argumento que el modelo escriba.
 */
export interface McpConnection {
  /** `?tools=` — la allow-list del agente. Ausente = sin filtro. */
  toolNames?: string[]
  /** `?run=` — qué ejecución habla. Los tools de cierre lo usan para no pisar
   *  un run más nuevo de la misma tarea con el cierre tardío de uno viejo. */
  runId?: string
  /** `?agent=` / `?project=` — namespace de `memory_*` y especialización. */
  agentId?: string
  projectId?: string
  /** `?task=` — fallback cuando el modelo no transcribe `task_id`. */
  taskId?: string
}

export interface McpServerDeps {
  /** El `serverInfo.name` del handshake. Identifica QUÉ servidor es, que con
   *  dos conectados al mismo run deja de ser una constante. */
  serverName: string
  /**
   * Con qué `providerKind` resuelve este host — o sea, si ofrece el sandbox
   * que las tools de escritura y ejecución necesitan.
   *
   * Default `'async'`, que es el daemon: sirviendo a un CLI de terminal no
   * construye worktree ni `writePaths`, y por eso `bash_run` y
   * `workspace_reset` declaran `providerKinds: ['sync']` — ahí serían un
   * footgun.
   *
   * El agent-host declara `'sync'` porque el sandbox SÍ existe: su
   * `prepareWorkspace` materializó el worktree y resolvió los `writePaths`
   * antes de arrancar el run. Es lo que hace que esas dos tools vuelvan a
   * estar disponibles, y encima con el allow/deny de la policy aplicado —
   * algo que el Bash nativo del CLI no tiene.
   */
  providerKind?: ProviderKind
  /**
   * Recorte propio de este host sobre lo que el registry ofrece. El agent-host
   * sirve sólo las tools de disco; el daemon, todo lo demás.
   *
   * Se aplica DESPUÉS de `resolveTools`, así que no puede ampliar la
   * allow-list del agente — sólo restringirla.
   */
  serves?(tool: Tool): boolean
  /**
   * Config del agente que las tools especializadas necesitan (`select_exit`
   * necesita sus salidas, `submit_output` sus campos). Devolver `{}` ante
   * cualquier tropiezo: el efecto es que esas tools no se ofrecen, que es lo
   * mismo que le pasa a un agente que no declara nada. Fallar la conexión
   * entera por esto dejaría al agente sin NINGUNA tool.
   */
  agentOptions?(
    conn: McpConnection,
  ): Promise<Pick<ToolDefinitionsOptions, 'selectableExits' | 'outputFields'>>
  /** La parte del `ToolContext` que sólo este host sabe armar: sus repoPaths,
   *  su workspace, sus credenciales. */
  buildContext(conn: McpConnection): ToolContext | Promise<ToolContext>
}

/** El daemon, salvo que el host diga otra cosa. */
function kindOf(deps: McpServerDeps): ProviderKind {
  return deps.providerKind ?? 'async'
}

function rpcResult(id: JsonRpcId, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0' as const, id: id ?? null, result } }
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): McpResponse {
  return { status, body: { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } } }
}

async function toolDefinitions(conn: McpConnection, deps: McpServerDeps) {
  const perAgent = (await deps.agentOptions?.(conn)) ?? {}
  return resolveTools({ providerKind: kindOf(deps), toolNames: conn.toolNames, ...perAgent })
    .filter((t) => deps.serves?.(t) ?? true)
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }))
}

/**
 * El `ToolContext` de una llamada. Las reglas con las que `tools/list` decidió
 * qué se OFRECE se re-aplican acá para que un cliente no pueda invocar una
 * tool que nunca se le ofreció, sólo nombrándola.
 */
async function callContext(conn: McpConnection, deps: McpServerDeps): Promise<ToolContext> {
  const base = await deps.buildContext(conn)
  return {
    ...base,
    providerKind: kindOf(deps),
    // La allow-list la manda la CONEXIÓN —es lo que `tools/list` ofreció—,
    // pero el resto de la policy la aporta el host: `bash_run` lee de ahí sus
    // patrones allow/deny y sin ellos rechaza TODO comando. Mergear y no
    // pisar: antes esto dejaba la tool ofrecida y muerta en la primera
    // llamada.
    policy: conn.toolNames ? { ...base.policy, toolNames: new Set(conn.toolNames) } : base.policy,
    runId: conn.runId,
    agentId: conn.agentId,
    projectId: conn.projectId,
    taskId: conn.taskId,
  }
}

async function handleToolsCall(
  id: JsonRpcId,
  params: Record<string, unknown> | undefined,
  conn: McpConnection,
  deps: McpServerDeps,
): Promise<McpResponse> {
  const name = params?.name as string | undefined
  const args = (params?.arguments as unknown) ?? {}
  if (!name) return rpcError(id, -32602, 'Missing tool name')

  const ctx = await callContext(conn, deps)
  const tool = resolveExecutableTool(name, ctx)
  // El recorte del host se re-aplica en la ejecución: sin esto, nombrar una
  // tool que este server no ofrece la correría igual — y en el agent-host eso
  // sería un `add_issue_comment` sin conexión a la fuente.
  if (!tool || !(deps.serves?.(tool) ?? true)) {
    return rpcResult(id, {
      content: [{ type: 'text', text: `Tool '${name}' not found` }],
      isError: true,
    })
  }

  log.debug({ tool: name, args }, 'mcp tool call')
  try {
    const result = await tool.execute(args, ctx)
    return rpcResult(id, { content: [{ type: 'text', text: result }] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn({ tool: name, err: msg }, 'mcp tool call failed')
    return rpcResult(id, { content: [{ type: 'text', text: msg }], isError: true })
  }
}

/**
 * Un request JSON-RPC del transporte Streamable HTTP, stateless (sin SSE, sin
 * `Mcp-Session-Id`). Son cuatro métodos: no vale la pena el
 * `@modelcontextprotocol/sdk`, que además espera el `http` de Node y no el
 * `Request`/`Response` del runtime.
 */
export async function handleMcpRequest(
  body: JsonRpcRequest,
  conn: McpConnection,
  deps: McpServerDeps,
): Promise<McpResponse> {
  const { id, method, params } = body
  if (typeof method !== 'string' || !method) {
    return rpcError(id, -32600, 'Invalid Request: falta `method`', 400)
  }

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: deps.serverName, version: '1.0.0' },
    })
  }
  // Keep-alive del transporte. Responde `{}` — no tiene contenido, pero un
  // cliente que lo manda espera un result, no un error.
  if (method === 'ping') return rpcResult(id, {})
  if (method === 'tools/list') return rpcResult(id, { tools: await toolDefinitions(conn, deps) })
  if (method === 'tools/call') return handleToolsCall(id, params, conn, deps)

  // Notificaciones (`notifications/*`, y cualquier request sin `id`): el
  // cliente no espera cuerpo y JSON-RPC prohíbe contestarle un error. Un 404
  // acá era el "HTTP 404 dialing …/api/mcp" con el que el CLI daba por muerta
  // la conexión entera apenas mandaba una notificación.
  if (method.startsWith('notifications/') || id === undefined || id === null) {
    return { status: 202, body: null }
  }
  // Método desconocido = error de JSON-RPC, no de HTTP: el transporte
  // funcionó. Un 404 hace que el cliente descarte el body y reporte un fallo
  // de conexión en vez del `-32601`.
  log.debug({ method }, 'mcp: método no soportado')
  return rpcError(id, -32601, `Method not found: ${method}`)
}

/** El body de un JSON que no parseó. */
export function mcpParseError(): McpResponse {
  return rpcError(null, -32700, 'Parse error', 400)
}

/**
 * El GET del transporte. Un cliente Streamable HTTP (`"type": "http"`, que es
 * como viaja `ia-flow-tools`) abre primero un GET para el stream SSE y cierra
 * con un DELETE. Sin rutas para esos dos caían en el 404 default y el CLI daba
 * la conexión por muerta antes de llegar a `tools/list`.
 *
 * 405 y no 404 porque es lo que la spec define como "no ofrezco stream": el
 * cliente sigue con POSTs, que es todo lo que necesita.
 */
export function mcpNoStream(): McpResponse {
  return rpcError(null, -32601, 'SSE stream no soportado', 405)
}
