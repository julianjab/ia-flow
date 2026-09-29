import type {
  McpServerRef,
  Provider,
  ProviderRunContext,
  ProviderRunOutput,
  Tool,
} from '@ia-flow/agent-engine'
import { createLogger, traced } from '@ia-flow/telemetry'
import {
  AnthropicClient,
  type AnthropicClientOptions,
  type AnthropicContentBlock,
  type AnthropicMessagesResponse,
  type AnthropicRetryInfo,
  type AnthropicSendOptions,
} from './AnthropicClient.js'
import { chatTrace, toolTrace } from './tracing.js'

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AnthropicThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }

/**
 * Las perillas de una corrida, con la MISMA estructura en los dos niveles donde se configuran:
 *
 * - al registrar el provider (`new AnthropicProvider({ ...defaults })`), para todos sus agentes;
 * - en el `providerConfig` de cada agente, que pisa clave por clave lo del provider.
 *
 * Lo que ninguno de los dos define cae al default del paquete (`RUN_CONFIG_DEFAULTS`).
 */
export interface AnthropicRunConfig {
  model?: string
  maxTokens?: number
  /** Tope de vueltas del loop de tools (respuestas con `tool_use`), para no quedar colgado si el
   *  modelo no converge. */
  maxToolRounds?: number
  /** Cuántos `pause_turn` SEGUIDOS se reanudan (runs largos con tools server-side: MCP remoto,
   *  thinking extendido) — vuelve a cero con cada vuelta de tools. Tope aparte: una pausa no
   *  es una vuelta de tools. */
  maxPauseTurnRetries?: number
  maxRetries?: number
  /** Default true — ver `AnthropicSendOptions.stream` en `AnthropicClient`. */
  stream?: boolean
  thinking?: AnthropicThinkingConfig
  /** Atajo de ia-flow para `thinking: { type: 'enabled', budgetTokens }`; gana sobre `thinking`. */
  thinkingBudgetTokens?: number
  effort?: AnthropicEffort
  taskBudgetTokens?: number
  /** Por default las tools de cada MCP van diferidas (`defer_loading` + una tool de búsqueda
   *  regex). `true` carga todo el catálogo desde el primer request. */
  eagerMcpTools?: boolean
  /** Un corte por `max_tokens` reintenta UNA vez con el doble de presupuesto (tope 128000)
   *  antes de reportar `'truncated'`. Default true. */
  bumpMaxTokensOnTruncation?: boolean
}

/**
 * Todo lo que hace falta para el caso simple es `{ id, model }`. El resto de la config de una
 * corrida (`AnthropicRunConfig`) son los defaults del provider, que cada agente puede pisar.
 */
export interface AnthropicProviderOptions extends AnthropicClientOptions, AnthropicRunConfig {
  /** Id con el que se registra en `providerRegistry` — lo que cada `AgentDefinition` pone en
   *  `provider: '...'`. */
  id: string
  model: string
  /** Deriva `outcome` a partir del texto final de respuesta — default: siempre 'success'. */
  resolveOutcome?: (text: string) => string
  onToolCall?: (name: string, input: unknown, toolUseId: string | undefined) => void
  onToolResult?: (name: string, result: string, toolUseId: string | undefined) => void
  /** Se llama antes de cada request con la conversación completa — el caller decide si y dónde
   *  persistir un checkpoint reanudable. Este paquete no tiene storage propio; ver
   *  `AnthropicAgentProviderConfig.resumeMessages` para retomarlo. */
  onCheckpoint?: (messages: unknown[], ctx: ProviderRunContext) => void | Promise<void>
}

/** El `providerConfig` de un agente: la misma `AnthropicRunConfig` que el provider, más lo que
 *  sólo tiene sentido para UNA corrida. */
export interface AnthropicAgentProviderConfig extends AnthropicRunConfig {
  /** Retoma una conversación truncada en vez de arrancar del prompt. */
  resumeMessages?: AnthropicMessage[]
}

export type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown }

/** El body de un request a la Messages API — lo mínimo tipado que lee la traza; el resto va tal
 *  cual. */
export type ChatRequest = Record<string, unknown> & {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string | undefined
  content: string
  is_error?: true
}

const MAX_TOKEN_BUMP_CEILING = 128_000

/** Lo que usa una corrida cuando ni el provider ni el agente definen la clave. Pensado para el
 *  caso simple — un agente que trabaja sobre un repo necesita bastante más (ver el runner). */
export const RUN_CONFIG_DEFAULTS = {
  maxTokens: 1024,
  maxToolRounds: 8,
  maxPauseTurnRetries: 3,
  maxRetries: 3,
  stream: true,
  eagerMcpTools: false,
  bumpMaxTokensOnTruncation: true,
} as const satisfies AnthropicRunConfig

const EFFORTS: readonly AnthropicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const isPositiveInt = (value: unknown) => Number.isInteger(value) && (value as number) > 0
const isNonNegativeInt = (value: unknown) => Number.isInteger(value) && (value as number) >= 0
const isBoolean = (value: unknown) => typeof value === 'boolean'

/** Cómo se valida cada clave de `AnthropicRunConfig` — y la lista de las que existen: una clave
 *  que no está acá se rechaza, así un typo en el `providerConfig` rompe en vez de ignorarse. */
const RUN_CONFIG_CHECKS: Record<keyof AnthropicRunConfig, (value: unknown) => boolean> = {
  model: (value) => typeof value === 'string' && value.length > 0,
  maxTokens: isPositiveInt,
  maxToolRounds: isPositiveInt,
  maxPauseTurnRetries: isNonNegativeInt,
  maxRetries: isNonNegativeInt,
  stream: isBoolean,
  thinking: (value) => {
    const thinking = value as { type?: unknown; budgetTokens?: unknown } | null
    return (
      thinking?.type === 'adaptive' ||
      (thinking?.type === 'enabled' && isPositiveInt(thinking.budgetTokens))
    )
  },
  thinkingBudgetTokens: isPositiveInt,
  effort: (value) => EFFORTS.includes(value as AnthropicEffort),
  taskBudgetTokens: isPositiveInt,
  eagerMcpTools: isBoolean,
  bumpMaxTokensOnTruncation: isBoolean,
}

/**
 * Valida un `providerConfig` de agente contra la misma estructura del provider. Tira ante una
 * clave desconocida o un valor con el tipo equivocado — el caller (un runner al montar sus
 * agentes) lo puede llamar al bootear para fallar antes de la primera corrida.
 */
export function parseAnthropicAgentConfig(
  raw: Record<string, unknown>,
): AnthropicAgentProviderConfig {
  const config: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (key === 'resumeMessages') {
      if (!Array.isArray(value))
        throw new Error('providerConfig.resumeMessages: tiene que ser una lista')
      config[key] = value
      continue
    }
    if (!Object.hasOwn(RUN_CONFIG_CHECKS, key)) {
      const known = [...Object.keys(RUN_CONFIG_CHECKS), 'resumeMessages'].join(', ')
      throw new Error(
        `providerConfig.${key}: no es una opción de AnthropicProvider (hay: ${known})`,
      )
    }
    if (!RUN_CONFIG_CHECKS[key as keyof AnthropicRunConfig](value)) {
      throw new Error(`providerConfig.${key}: valor inválido ${JSON.stringify(value)}`)
    }
    config[key] = value
  }
  return config as AnthropicAgentProviderConfig
}

type ResolvedRunConfig = AnthropicRunConfig &
  Required<Pick<AnthropicRunConfig, 'model' | keyof typeof RUN_CONFIG_DEFAULTS>>

/** La config efectiva de una corrida, clave por clave: la del agente, si no la del provider, si
 *  no el default del paquete. */
function resolveRunConfig(
  provider: AnthropicProviderOptions,
  agent: AnthropicAgentProviderConfig,
): ResolvedRunConfig {
  const resolved: Record<string, unknown> = {}
  for (const key of Object.keys(RUN_CONFIG_CHECKS) as Array<keyof AnthropicRunConfig>) {
    resolved[key] = agent[key] ?? provider[key] ?? (RUN_CONFIG_DEFAULTS as AnthropicRunConfig)[key]
  }
  // `thinking` y `thinkingBudgetTokens` son dos formas de la MISMA perilla: se pisan juntas. Si el
  // agente define cualquiera, las del provider no cuentan — si no, un `thinkingBudgetTokens` del
  // provider le ganaría al `thinking: adaptive` del agente.
  if (agent.thinking !== undefined || agent.thinkingBudgetTokens !== undefined) {
    resolved.thinking = agent.thinking
    resolved.thinkingBudgetTokens = agent.thinkingBudgetTokens
  }
  return resolved as unknown as ResolvedRunConfig
}

/**
 * El token de un MCP server: un string fijo, o una función que lo devuelve en cada request. La
 * función es para tokens que vencen (el installation token de una GitHub App dura una hora):
 * resolverlo una sola vez al bootear lo deja vencido en un proceso de larga vida.
 */
export type McpAuthorizationToken = string | (() => string | Promise<string>)

interface ApiMcpServer {
  name: string
  url: string
  token?: McpAuthorizationToken
}

/** Mapea `McpServerRef` (id + config libre) → los `mcp_servers[]` de la API, sin el token (se
 *  resuelve por request, ver `withTokens`). Sólo entradas con `config.url` — el conector MCP
 *  remoto de Anthropic es la única modalidad soportada acá (stdio no cruza la red). */
function toApiMcpServers(servers: McpServerRef[]): ApiMcpServer[] | undefined {
  const out: ApiMcpServer[] = []
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
    out.push({ name: server.id, url: config.url, ...(token ? { token } : {}) })
  }
  return out.length > 0 ? out : undefined
}

/** Los `mcp_servers[]` de UN request, con el token vigente de cada uno. */
async function withTokens(servers: ApiMcpServer[]): Promise<Array<Record<string, unknown>>> {
  return Promise.all(
    servers.map(async ({ name, url, token }) => {
      const value = typeof token === 'function' ? await token() : token
      return { name, type: 'url', url, ...(value ? { authorization_token: value } : {}) }
    }),
  )
}

/** Un solo breakpoint de cache, en el ÚLTIMO bloque de system — el caching de la API es prefix
 *  match, así que marcar cada bloque no compra nada y consume el tope de 4 `cache_control` por
 *  request contra tools/mensajes. */
function buildSystemBlocks(systemPrompts: string[]): Array<Record<string, unknown>> {
  return systemPrompts.map((text, i) =>
    i === systemPrompts.length - 1
      ? { type: 'text', text, cache_control: { type: 'ephemeral' } }
      : { type: 'text', text },
  )
}

function buildThinkingConfig(
  agentThinkingBudget: number | undefined,
  effectiveMaxTokens: number,
  defaultThinking: AnthropicThinkingConfig | undefined,
): Record<string, unknown> | undefined {
  // budget_tokens < max_tokens es requisito de la API — clampeado bajo effectiveMaxTokens (que
  // ya puede haber subido por el bump de truncamiento) en vez de confiar ciegamente en la
  // config, sea que el budget venga del override por-agente o del default del provider (los dos
  // caen acá, no sólo el override — un `new AnthropicProvider({ thinking: { budgetTokens } })`
  // con el `maxTokens` default de 1024 mandaría un budget >= max_tokens sin este clamp, y la
  // API rechaza eso con 400).
  const requestedBudget =
    agentThinkingBudget ??
    (defaultThinking?.type === 'enabled' ? defaultThinking.budgetTokens : undefined)
  if (requestedBudget != null) {
    const clamped = Math.min(requestedBudget, effectiveMaxTokens - 1024)
    if (clamped >= 1024) return { type: 'enabled', budget_tokens: clamped }
  }
  return defaultThinking?.type === 'adaptive' ? { type: 'adaptive' } : undefined
}

function buildOutputConfig(
  effort: AnthropicEffort | undefined,
  taskBudgetTokens: number | undefined,
): Record<string, unknown> | undefined {
  const outputConfig: Record<string, unknown> = {}
  if (effort) outputConfig.effort = effort
  if (taskBudgetTokens != null)
    outputConfig.task_budget = { type: 'tokens', total: taskBudgetTokens }
  return Object.keys(outputConfig).length > 0 ? outputConfig : undefined
}

/**
 * Anthropic resuelve un `mcp_tool_use` server-side y devuelve su `mcp_tool_result` en el MISMO
 * `content` — si ese par llega roto, reenviar la conversación tal cual la deja 400 PARA SIEMPRE
 * (la API rechaza cualquier `mcp_tool_use` sin su `mcp_tool_result`). Se saca el bloque huérfano
 * antes de cada request: el modelo pierde esa tool call puntual, no toda la conversación.
 */
function stripOrphanedMcpToolUse(messages: AnthropicMessage[]): AnthropicMessage[] {
  let sanitized: AnthropicMessage[] | undefined
  messages.forEach((msg, index) => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return
    const content = msg.content as AnthropicContentBlock[]
    const resultIds = new Set(
      content.filter((b) => b.type === 'mcp_tool_result').map((b) => b.tool_use_id),
    )
    const orphaned = content.filter((b) => b.type === 'mcp_tool_use' && !resultIds.has(b.id))
    if (orphaned.length === 0) return
    const remaining = content.filter((b) => !orphaned.includes(b))
    const nextContent: AnthropicContentBlock[] =
      remaining.length > 0
        ? remaining
        : [{ type: 'text', text: '[mcp tool call descartada: nunca volvió un resultado]' }]
    sanitized ??= [...messages]
    sanitized[index] = { ...msg, content: nextContent }
  })
  return sanitized ?? messages
}

/** Vale la pena insistir si el agente no puede cerrar solo: más de una salida, o una única salida
 *  que pide datos. Con una sola `submit_done` sin campos requeridos, `Agent` la toma sin submit. */
/**
 * Lo que llegó mientras el agente corre (`ctx.inbox`, `ifRunning: inject`) entra al turno del
 * usuario que está por mandarse — después de los `tool_result`, que la API exige primero. Sólo
 * si el último mensaje es del usuario: tras un `pause_turn` el último es del asistente (el turno
 * sigue), así que el inbox espera a la vuelta siguiente en vez de cortar esa continuación.
 */
function withInjectedMessages(
  messages: AnthropicMessage[],
  inbox: (() => string[]) | undefined,
): AnthropicMessage[] {
  const last = messages.at(-1)
  if (!inbox || last?.role !== 'user') return messages
  const injected = inbox()
  if (injected.length === 0) return messages
  const blocks = injected.map((text) => ({
    type: 'text',
    text: `[Mensaje recibido mientras trabajabas]\n${text}`,
  }))
  const content = Array.isArray(last.content)
    ? [...last.content, ...blocks]
    : [{ type: 'text', text: String(last.content) }, ...blocks]
  return [...messages.slice(0, -1), { role: 'user', content }]
}

function needsSubmit(terminalTools: Tool[]): boolean {
  if (terminalTools.length === 0) return false
  if (terminalTools.length > 1) return true
  const required = terminalTools[0]?.inputSchema.required
  return Array.isArray(required) && required.length > 0
}

/**
 * Provider de Anthropic — implementa `Provider` (`@ia-flow/agent-engine`) contra la Messages
 * API real: streaming, retries, extended thinking, task budgets, MCP remoto y checkpointing,
 * portado de `ia-flow/packages/ai-providers/src/anthropic-api`. Uso mínimo:
 *
 * ```ts
 * providerRegistry.register(new AnthropicProvider({ id: 'anthropic-api', model: 'claude-sonnet-5' }));
 * ```
 *
 * Todo lo demás (thinking, task budgets, MCP, checkpointing) es opt-in vía `AnthropicProviderOptions`
 * o, por-agente, vía `AgentDefinitionProps.providerConfig` (ver `AnthropicAgentProviderConfig`).
 */
export class AnthropicProvider implements Provider {
  readonly id: string
  readonly log = createLogger('provider-anthropic')
  private readonly client: AnthropicClient

  constructor(private readonly options: AnthropicProviderOptions) {
    this.id = options.id
    this.client = new AnthropicClient(options)
  }

  async run(ctx: ProviderRunContext): Promise<ProviderRunOutput> {
    const opts = this.options
    const pc = parseAnthropicAgentConfig(ctx.providerConfig ?? {})
    const cfg = resolveRunConfig(opts, pc)

    const model = cfg.model
    const maxTokens = cfg.maxTokens
    const maxRetries = cfg.maxRetries
    const maxToolRounds = cfg.maxToolRounds
    const useStream = cfg.stream
    const eagerMcpTools = cfg.eagerMcpTools
    const bumpOnTruncation = cfg.bumpMaxTokensOnTruncation

    const apiMcpServers = toApiMcpServers(ctx.mcpServers)
    const deferMcpTools = apiMcpServers !== undefined && !eagerMcpTools

    const extraBetas: string[] = []
    const taskBudgetTokens = cfg.taskBudgetTokens
    if (taskBudgetTokens != null) extraBetas.push('task-budgets-2026-03-13')
    if (apiMcpServers) extraBetas.push('mcp-client-2025-11-20')

    const systemBlocks = buildSystemBlocks(ctx.systemPrompts)
    const toolDefs = ctx.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))
    const toolSearch = deferMcpTools
      ? [{ type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' }]
      : []
    const mcpToolsets = apiMcpServers?.map((s) => ({
      type: 'mcp_toolset',
      mcp_server_name: s.name,
      ...(deferMcpTools ? { default_config: { defer_loading: true } } : {}),
    }))
    const allTools = [...toolSearch, ...toolDefs, ...(mcpToolsets ?? [])]

    let messages: AnthropicMessage[] = pc.resumeMessages ?? [{ role: 'user', content: ctx.prompt }]
    // Las salidas; `fail_turn` (failure) también es terminal, pero no cuenta para insistir.
    const terminalTools = ctx.tools.filter((tool) => tool.terminal && !tool.failure)
    let nudged = false

    let toolRounds = 0
    let pauses = 0
    for (let round = 0; ; round++) {
      messages = withInjectedMessages(messages, ctx.inbox)
      await opts.onCheckpoint?.(messages, ctx)

      const sendOnce = async (effectiveMaxTokens: number): Promise<AnthropicMessagesResponse> => {
        const thinking = buildThinkingConfig(
          cfg.thinkingBudgetTokens,
          effectiveMaxTokens,
          cfg.thinking,
        )
        const outputConfig = buildOutputConfig(cfg.effort, taskBudgetTokens)
        const body: ChatRequest = {
          model,
          max_tokens: effectiveMaxTokens,
          system: systemBlocks,
          messages: stripOrphanedMcpToolUse(messages),
          // Auto-cache a nivel request, además del breakpoint explícito del system: cachea el
          // último bloque cacheable de `messages` y lo corre sola en cada vuelta.
          cache_control: { type: 'ephemeral' },
        }
        if (allTools.length > 0) body.tools = allTools
        if (thinking) body.thinking = thinking
        if (apiMcpServers) body.mcp_servers = await withTokens(apiMcpServers)
        if (outputConfig) body.output_config = outputConfig
        return this.send(body, round, { stream: useStream, extraBetas, maxRetries })
      }

      let data = await sendOnce(maxTokens)

      if (data.stop_reason === 'max_tokens' && bumpOnTruncation) {
        const bumped = Math.min(maxTokens * 2, MAX_TOKEN_BUMP_CEILING)
        if (bumped > maxTokens) data = await sendOnce(bumped)
      }

      if (data.stop_reason === 'max_tokens') {
        // Se quedó sin tokens a mitad de la respuesta — NO es un resultado del agente, así que
        // el outcome es 'truncated': `Agent.run` (agent-engine) trata esto como
        // NO_TRANSITION_OUTCOMES y no aplica ninguna transición, en vez de leer un texto
        // cortado a la mitad como 'success'.
        const text = data.content.find((block) => block.type === 'text')?.text ?? ''
        return { outcome: 'truncated', summary: text }
      }

      if (data.stop_reason === 'end_turn' || data.stop_reason === 'stop_sequence') {
        // El agente ofrece tools terminales (`submit_<salida>`) y el modelo cerró sin llamar
        // ninguna: se le insiste UNA vez. Sin `tool_choice` forzado a propósito — no convive con
        // extended thinking. Si igual no llama, `Agent` decide (falla o toma la única salida).
        if (needsSubmit(terminalTools) && !nudged) {
          nudged = true
          messages = [
            ...messages,
            { role: 'assistant', content: data.content },
            {
              role: 'user',
              content: `Para terminar tu turno tenés que llamar a una de estas tools: ${terminalTools.map((tool) => tool.name).join(', ')}.`,
            },
          ]
          continue
        }
        const text = data.content.find((block) => block.type === 'text')?.text ?? ''
        return { outcome: opts.resolveOutcome?.(text) ?? 'success', summary: text }
      }

      if (data.stop_reason === 'pause_turn') {
        // El modelo se pausó a MITAD de turno — no es una pausa entre turnos (eso sería
        // `end_turn`/`tool_use` normal), es el mecanismo que usa la API para runs largos con
        // tools server-side (MCP remoto, extended thinking): el turno sigue, así que se
        // reenvía la conversación con el contenido parcial agregado, sin turno de usuario de
        // por medio, y el modelo continúa desde donde quedó. Tiene su propio tope
        // (`maxPauseTurnRetries`): una pausa no es una vuelta de tools, pero tampoco puede
        // repetirse sin fin.
        if (pauses >= cfg.maxPauseTurnRetries) {
          throw new Error(
            `AnthropicProvider(${opts.id}): superó maxPauseTurnRetries (${cfg.maxPauseTurnRetries}) sin converger`,
          )
        }
        pauses++
        messages = [...messages, { role: 'assistant', content: data.content }]
        continue
      }

      if (data.stop_reason !== 'tool_use') {
        // `null`, o cualquier otro stop_reason que la API llegue a agregar — no se adivina
        // como éxito.
        throw new Error(
          `AnthropicProvider(${opts.id}): stop_reason inesperado "${data.stop_reason}"`,
        )
      }

      const toolUseBlocks = data.content.filter((block) => block.type === 'tool_use')
      const toolResults = await Promise.all(
        toolUseBlocks.map((block) => this.executeTool(block, ctx.tools)),
      )
      // Una tool terminal que devolvió OK (`submit_<salida>` validado) cierra el turno ahí: no
      // hace falta otra vuelta a la API para que el modelo diga "listo".
      const submitted = toolUseBlocks.some((block, index) => {
        const tool = ctx.tools.find((candidate) => candidate.name === block.name)
        const result = toolResults[index] as { is_error?: boolean } | undefined
        return tool?.terminal === true && result?.is_error !== true
      })
      if (submitted) {
        const text = data.content.find((block) => block.type === 'text')?.text ?? ''
        return { outcome: 'success', summary: text }
      }
      toolRounds++
      // `maxPauseTurnRetries` cuenta pausas SEGUIDAS: una vuelta de tools es progreso, así que
      // una corrida larga puede pausarse muchas veces en total sin llegar al tope.
      pauses = 0
      if (toolRounds > maxToolRounds) {
        throw new Error(
          `AnthropicProvider(${opts.id}): superó maxToolRounds (${maxToolRounds}) sin converger`,
        )
      }
      messages = [
        ...messages,
        { role: 'assistant', content: data.content },
        { role: 'user', content: toolResults },
      ]
    }
  }

  @traced(chatTrace)
  private send(
    body: ChatRequest,
    _round: number,
    sendOptions: AnthropicSendOptions,
  ): Promise<AnthropicMessagesResponse> {
    return this.client.send(body, sendOptions)
  }

  @traced(toolTrace)
  private async executeTool(block: AnthropicContentBlock, tools: Tool[]): Promise<ToolResultBlock> {
    const { onToolCall, onToolResult } = this.options
    const finish = (content: string, isError: boolean): ToolResultBlock => {
      onToolResult?.(block.name ?? '', content, block.id)
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content,
        ...(isError ? { is_error: true } : {}),
      }
    }
    onToolCall?.(block.name ?? '', block.input, block.id)
    const tool = tools.find((t) => t.name === block.name)
    if (tool == null) {
      return finish(`Error: no existe una tool registrada con nombre "${block.name}"`, true)
    }
    // Un `handler` que tira (input inválido, la API de negocio de abajo falla) no puede
    // tumbar el loop entero — el modelo tiene que verlo como un `tool_result` con
    // `is_error: true` para poder corregirse, en vez de que el run entero termine en una
    // excepción no manejada.
    try {
      return finish(String(await tool.handler(block.input)), false)
    } catch (err) {
      return finish(`Error: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }
}

export type { AnthropicClientOptions, AnthropicRetryInfo }
