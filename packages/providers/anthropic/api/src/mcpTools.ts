/**
 * Los MCP de un agente como tools normales: el provider les habla él mismo (`McpHttpClient`) y el
 * modelo las llama con `tool_use`, como a cualquier otra. Es la alternativa al conector de
 * Anthropic (`mcp_servers`), que no acepta el OAuth de una suscripción de Claude Code.
 */
import { createHash } from 'node:crypto'
import type { McpServerRef, Tool } from '@ia-flow/agent-engine'
import type { McpAuthorizationToken } from './AnthropicProvider.js'
import { McpHttpClient } from './McpHttpClient.js'

/** Lo que hace falta para conectarse a un MCP por HTTP. */
export interface McpEndpoint {
  id: string
  url: string
  token?: McpAuthorizationToken
}

/** Un servidor que no se pudo listar: el agente corre sin sus tools. */
export interface McpLoadFailure {
  server: string
  error: string
}

export interface McpToolset {
  tools: Tool[]
  failures: McpLoadFailure[]
}

/** La API acepta `^[a-zA-Z0-9_-]{1,128}$`; 64 deja margen para los clientes más estrictos. */
const MAX_NAME = 64

/** `McpServerRef` (id + config libre) → los que tienen URL, con su bearer: `authorizationToken`,
 *  o el `Authorization: Bearer` de `headers`. Sin URL no hay transporte que cruce la red. */
export function mcpEndpoints(servers: McpServerRef[]): McpEndpoint[] {
  const out: McpEndpoint[] = []
  for (const server of servers) {
    const config = server.config as {
      url?: string
      authorizationToken?: McpAuthorizationToken
      headers?: Record<string, string>
    }
    if (!config.url) continue
    const bearer = config.headers?.Authorization?.startsWith('Bearer ')
      ? config.headers.Authorization.slice('Bearer '.length)
      : undefined
    const token = config.authorizationToken ?? bearer
    out.push({ id: server.id, url: config.url, ...(token ? { token } : {}) })
  }
  return out
}

/** `<servidor>__<tool>`, con lo que la API no acepta reemplazado por `_`. Si no entra, se corta y
 *  se le agrega un hash corto del nombre completo, para que dos tools largas no choquen. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_')
  const name = `${clean(server)}__${clean(tool)}`
  if (name.length <= MAX_NAME) return name
  const hash = createHash('sha256').update(`${server}/${tool}`).digest('hex').slice(0, 8)
  return `${name.slice(0, MAX_NAME - hash.length - 1)}_${hash}`
}

/** Las tools de todos los servidores, listadas en paralelo. Uno que falla no tumba a los demás:
 *  queda en `failures` y el agente corre sin él. */
export async function loadMcpTools(
  endpoints: McpEndpoint[],
  options: { fetchImpl?: typeof fetch } = {},
): Promise<McpToolset> {
  const results = await Promise.allSettled(
    endpoints.map((endpoint) => serverTools(endpoint, options.fetchImpl)),
  )
  const tools: Tool[] = []
  const failures: McpLoadFailure[] = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') tools.push(...result.value)
    else {
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason)
      failures.push({ server: endpoints[index]?.id ?? '?', error })
    }
  })
  return { tools, failures }
}

async function serverTools(endpoint: McpEndpoint, fetchImpl?: typeof fetch): Promise<Tool[]> {
  const client = new McpHttpClient({
    url: endpoint.url,
    ...(endpoint.token ? { authorizationToken: endpoint.token } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  })
  const listed = await client.listTools()
  return listed.map((info) => ({
    name: mcpToolName(endpoint.id, info.name),
    // El servidor va en la descripción: la tool search la encuentra también por él.
    description: `[${endpoint.id}] ${info.description ?? info.name}`,
    inputSchema: info.inputSchema ?? { type: 'object', properties: {} },
    handler: async (input: unknown) => {
      const result = await client.callTool(info.name, input)
      // Tirar es cómo una tool le dice al loop que falló: vuelve como `tool_result` con `is_error`.
      if (result.isError) throw new Error(result.text || `${info.name} devolvió un error`)
      return result.text
    },
  }))
}
