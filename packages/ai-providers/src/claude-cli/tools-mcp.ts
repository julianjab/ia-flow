// Cómo le llegan al CLI `claude` las tools del agente: como servers MCP
// sintéticos apuntados al registry de ia-flow.
//
// Vive al lado de `mcp-config.ts` —que es quien los escribe al disco— y no
// dentro de `terminal/`, porque hay DOS providers que spawnean el CLI y
// necesitan exactamente lo mismo: los de terminal (`tmux`, `iterm`) y
// `claude-print`. Mientras esto estuvo adentro de `terminal/base.ts`,
// `claude-print` simplemente no entregaba ninguna tool del agente.
//
// Es la contracara del camino sync (`anthropic-api`), que recibe las
// definiciones inyectadas y corre el loop él mismo. Un CLI no acepta
// definiciones: su única puerta de entrada es `--mcp-config`.
import type { McpServers } from '@ia-flow/shared'
import type { ProviderInput } from '../contract.js'

/** El MCP de tools de disco del proceso que hospeda al CLI (hoy, el
 *  `/v1/mcp` del agent-host). */
export interface LocalToolsMcp {
  /** baseUrl por donde el CLI lo alcanza — localhost: corre al lado. */
  url: string
  token?: string
  /** ¿Esta tool opera sobre el disco de este proceso? */
  owns(toolName: string): boolean
}

/** `input.daemonUrl` cuando el run viene de otra máquina (un agent-host); el
 *  localhost de siempre cuando el daemon corre acá al lado. */
export function resolveDaemonUrl(input: ProviderInput): string {
  return (
    input.daemonUrl ?? `http://localhost:${Bun.env.IA_FLOW_SERVER_PORT ?? Bun.env.PORT ?? '3001'}`
  )
}

/** El env sólo vale cuando el daemon es el local: si el run vino de otra
 *  máquina (`input.daemonUrl`), el `IA_FLOW_API_TOKEN` de este proceso es el
 *  del agent-host y no abre nada del daemon de origen — ese lo manda el
 *  daemon en `input.daemonToken`. */
export function resolveDaemonToken(input: ProviderInput): string | undefined {
  return (
    input.daemonToken?.trim() || (input.daemonUrl ? undefined : Bun.env.IA_FLOW_API_TOKEN?.trim())
  )
}

/** Un MCP sintético del registry de ia-flow. Las tools que sirve,
 *  `run`/`agent`/`project`/`task` viajan en la URL porque MCP no tiene dónde
 *  colgar contexto por llamada. */
function buildIaFlowToolsMcpServer(
  input: ProviderInput,
  baseUrl: string,
  path: string,
  toolNames: string[],
  token: string | undefined,
  kind: 'sync' | 'async' | undefined,
): McpServers[string] {
  const params = new URLSearchParams({ tools: toolNames.join(',') })
  if (input.runId) params.set('run', input.runId)
  if (input.agentId) params.set('agent', input.agentId)
  if (input.projectId) params.set('project', input.projectId)
  if (input.taskId) params.set('task', input.taskId)
  // Cómo CIERRA el run quien abre esta conexión. Un `claude -p` es sync —el
  // engine lee su `stopReason`— así que ofrecerle `complete_task` le daría un
  // segundo cierre que sacaría la task del registry a mitad del run. Viaja en
  // la conexión por lo mismo que el resto: MCP no tiene dónde ponerlo.
  if (kind) params.set('kind', kind)
  return {
    type: 'http',
    url: `${baseUrl}${path}?${params.toString()}`,
    // `writeMcpConfigFile` lo traduce a `Authorization: Bearer <token>`, que
    // es una de las dos formas que acepta el guard.
    ...(token ? { authorizationToken: token } : {}),
  }
}

export interface ResolveMcpServersInput {
  input: ProviderInput
  /** Los MCP que el agente declaró en su `providerConfig`. */
  configured: McpServers | undefined
  daemonUrl: string
  daemonToken: string | undefined
  localTools: LocalToolsMcp | undefined
  /** Cómo cierra el run este provider. Ver `buildIaFlowToolsMcpServer`. */
  kind?: 'sync' | 'async'
}

/**
 * Merge de los MCP servers configurados con los sintéticos de ia-flow.
 *
 * **Son dos cuando hay dos discos.** Corriendo dentro de un agent-host, el
 * workspace del run está en ESA máquina y el estado del pipeline (la fuente
 * de issues, GitHub, Slack, la memoria, los tools de cierre) está en el
 * daemon. Mandar todo a un solo lado obliga a equivocarse en la mitad: iba
 * todo al daemon, y los `fs_*` del agente escribían en el disco equivocado
 * mientras su Read/Write nativo operaba en el otro.
 *
 * Sin `localTools` —un run local, donde el daemon YA es esta máquina— sale un
 * solo server.
 */
export function resolveMcpServers({
  input,
  configured,
  daemonUrl,
  daemonToken,
  localTools,
  kind,
}: ResolveMcpServersInput): McpServers {
  const mcpServers: McpServers = { ...(configured ?? {}) }
  if (!input.tools?.length) return mcpServers

  const agentDisk = localTools ? input.tools.filter((t) => localTools.owns(t)) : []
  const daemon = localTools ? input.tools.filter((t) => !localTools.owns(t)) : input.tools

  // Un server sin una sola tool no se declara: el CLI abriría la conexión,
  // pagaría el handshake y recibiría una lista vacía.
  if (daemon.length) {
    mcpServers['ia-flow-tools'] = buildIaFlowToolsMcpServer(
      input,
      daemonUrl,
      '/api/mcp',
      daemon,
      daemonToken,
      kind,
    )
  }
  if (localTools && agentDisk.length) {
    mcpServers['ia-flow-local'] = buildIaFlowToolsMcpServer(
      input,
      localTools.url,
      '/v1/mcp',
      agentDisk,
      localTools.token,
      kind,
    )
  }
  return mcpServers
}
