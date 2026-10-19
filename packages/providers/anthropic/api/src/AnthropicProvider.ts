import type { Provider, ProviderRunContext, ProviderRunOutput, Tool } from '@ia-flow/agent-engine'
import { createLogger, traced } from '@ia-flow/telemetry'
import {
  AnthropicClient,
  type AnthropicClientOptions,
  type AnthropicContentBlock,
  type AnthropicDeltaHandler,
  type AnthropicMessagesResponse,
  type AnthropicRetryInfo,
  type AnthropicSendOptions,
} from './AnthropicClient.js'
import { buildContextManagement, CONTEXT_MANAGEMENT_BETA, clipToolResult } from './context.js'
import {
  awaitsServerCalls,
  pairOrphanedMcpToolUse,
  withAssistant,
  withAssistantThenUser,
} from './conversation.js'
import { loadMcpTools, type McpEndpoint, mcpEndpoints } from './mcpTools.js'
import {
  type AnthropicAgentProviderConfig,
  type AnthropicEffort,
  type AnthropicMessage,
  type AnthropicRunConfig,
  type AnthropicThinkingConfig,
  parseAnthropicAgentConfig,
  type ResolvedRunConfig,
  resolveRunConfig,
} from './runConfig.js'
import { chatTrace, describeBlocks, logRejectedRequest, toolTrace } from './tracing.js'

export type {
  AnthropicAgentProviderConfig,
  AnthropicClearToolUsesConfig,
  AnthropicEffort,
  AnthropicMessage,
  AnthropicRunConfig,
  AnthropicThinkingConfig,
  McpTransport,
} from './runConfig.js'
export { parseAnthropicAgentConfig, RUN_CONFIG_DEFAULTS } from './runConfig.js'

/**
 * Todo lo que hace falta para el caso simple es `{ id, model }`. El resto de la config de una
 * corrida (`AnthropicRunConfig`) son los defaults del provider, que cada agente puede pisar.
 */
export interface AnthropicProviderOptions extends AnthropicClientOptions, AnthropicRunConfig {
  /** Cuántos agentes corren a la vez sobre este provider (`Provider.maxConcurrent`). */
  maxConcurrent?: number
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
  /** El `fetch` hacia los MCP con `mcpTransport: client` (tests). */
  mcpFetchImpl?: typeof fetch
}

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

/**
 * El token de un MCP server: un string fijo, o una función que lo devuelve en cada request. La
 * función es para tokens que vencen (el installation token de una GitHub App dura una hora):
 * resolverlo una sola vez al bootear lo deja vencido en un proceso de larga vida.
 */
export type McpAuthorizationToken =
  | string
  /** Con `force`, el servidor rechazó el anterior: descartá la caché y resolvé uno nuevo. */
  | ((options?: { force?: boolean }) => string | Promise<string>)

/** Los `mcp_servers[]` de UN request para el conector, con el token vigente de cada uno (se
 *  resuelve por request: el de una GitHub App vence a la hora). */
async function withTokens(servers: McpEndpoint[]): Promise<Array<Record<string, unknown>>> {
  return Promise.all(
    servers.map(async ({ id, url, token }) => {
      const value = typeof token === 'function' ? await token() : token
      return { name: id, type: 'url', url, ...(value ? { authorization_token: value } : {}) }
    }),
  )
}

const TOOL_SEARCH = { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' }

/** Las tools de UNA corrida, ya en la forma de la API, y quién las ejecuta. */
interface RunTools {
  /** Las del agente más las de sus MCP (con `mcpTransport: client`): las que se ejecutan acá. */
  tools: Tool[]
  /** El `tools` del body: la búsqueda, las de arriba y los toolsets del conector. */
  apiTools: Array<Record<string, unknown>>
  /** Los servidores para `mcp_servers` (sólo con el conector). */
  connector?: McpEndpoint[]
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

/** Vale la pena insistir si el agente no puede cerrar solo: más de una salida, o una única salida
 *  que pide datos. Con una sola `submit_done` sin campos requeridos, `Agent` la toma sin submit. */
/**
 * Lo que llegó mientras el agente corre (`ctx.inbox`, `ifRunning: inject`) entra al turno del
 * usuario que está por mandarse — después de los `tool_result`, que la API exige primero. Sólo si
 * el último mensaje es del usuario (tras un `pause_turn` es del asistente) y el turno no tiene
 * llamadas MCP pendientes: un texto lo cerraría y la API rechaza la llamada sin result. Lo que no
 * entra queda en la bandeja para la vuelta siguiente.
 */
async function withInjectedMessages(
  messages: AnthropicMessage[],
  inbox: ProviderRunContext['inbox'],
): Promise<AnthropicMessage[]> {
  const last = messages.at(-1)
  if (!inbox || last?.role !== 'user' || awaitsServerCalls(messages)) return messages
  const injected = await inbox()
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

/**
 * La conversación que se retoma (`ctx.resume`), con lo que pasó mientras tanto sumado al último
 * turno del usuario — que es siempre el de los resultados de tools de la vuelta en la que quedó.
 * Una conversación que no es de este provider se ignora: se empieza del prompt.
 */
function resumedConversation(ctx: ProviderRunContext): AnthropicMessage[] | undefined {
  const resume = ctx.resume
  if (!resume || !isConversation(resume.conversation)) return undefined
  const conversation = resume.conversation
  const last = conversation.at(-1)
  const note = { type: 'text', text: `[Mientras esperabas]\n${resume.message}` }
  if (last?.role !== 'user') return [...conversation, { role: 'user', content: [note] }]
  const content = Array.isArray(last.content)
    ? [...last.content, note]
    : [{ type: 'text', text: String(last.content) }, note]
  return [...conversation.slice(0, -1), { role: 'user', content }]
}

function isConversation(value: unknown): value is AnthropicMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        ((message as { role?: unknown }).role === 'user' ||
          (message as { role?: unknown }).role === 'assistant'),
    )
  )
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
  readonly maxConcurrent?: number
  readonly log = createLogger('provider-anthropic-api')
  private readonly client: AnthropicClient

  constructor(private readonly options: AnthropicProviderOptions) {
    this.id = options.id
    if (options.maxConcurrent !== undefined) this.maxConcurrent = options.maxConcurrent
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
    const bumpOnTruncation = cfg.bumpMaxTokensOnTruncation

    const { tools, apiTools: allTools, connector: apiMcpServers } = await this.runTools(ctx, cfg)

    const extraBetas: string[] = []
    const taskBudgetTokens = cfg.taskBudgetTokens
    if (taskBudgetTokens != null) extraBetas.push('task-budgets-2026-03-13')
    if (apiMcpServers) extraBetas.push('mcp-client-2025-11-20')
    const contextManagement = buildContextManagement(cfg.clearToolUses)
    if (contextManagement) extraBetas.push(CONTEXT_MANAGEMENT_BETA)

    const systemBlocks = buildSystemBlocks([...(cfg.systemPrompts ?? []), ...ctx.systemPrompts])

    let messages: AnthropicMessage[] = resumedConversation(ctx) ??
      pc.resumeMessages ?? [{ role: 'user', content: ctx.prompt }]
    // Las salidas; `fail_turn` (failure) también es terminal, pero no cuenta para insistir.
    const terminalTools = ctx.tools.filter((tool) => tool.terminal && !tool.failure)
    let nudged = false
    // El texto en vivo (`ctx.onText`): sólo los deltas de texto, no el thinking. Sin streaming no
    // hay deltas — el caller ve el texto recién en el span de la llamada.
    const onText = ctx.onText
    const onDelta: AnthropicDeltaHandler | undefined = onText
      ? (delta) => {
          if (delta.type === 'text') onText(delta.delta)
        }
      : undefined

    let toolRounds = 0
    let pauses = 0
    for (let round = 0; ; round++) {
      // Cortada desde afuera (quien la delegó la dio por terminada): no arranca otra vuelta.
      if (ctx.signal?.aborted) {
        const reason = typeof ctx.signal.reason === 'string' ? `: ${ctx.signal.reason}` : ''
        return { outcome: 'error', summary: `la corrida se cortó desde afuera${reason}` }
      }
      messages = await withInjectedMessages(messages, ctx.inbox)
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
          messages: pairOrphanedMcpToolUse(messages, (paired) =>
            this.log.warn(
              `mcp_tool_use sin result en el mensaje ${paired.index}: pareado con un error (vuelta ${round})`,
              {
                'ia.round': round,
                'ia.message.index': paired.index,
                'ia.paired': JSON.stringify(paired.paired),
              },
            ),
          ),
          // Auto-cache a nivel request, además del breakpoint explícito del system: cachea el
          // último bloque cacheable de `messages` y lo corre sola en cada vuelta.
          cache_control: { type: 'ephemeral' },
        }
        if (allTools.length > 0) body.tools = allTools
        if (thinking) body.thinking = thinking
        if (apiMcpServers) body.mcp_servers = await withTokens(apiMcpServers)
        if (outputConfig) body.output_config = outputConfig
        if (contextManagement) body.context_management = contextManagement
        return this.send(body, round, { stream: useStream, extraBetas, maxRetries, onDelta })
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
          this.log.info(`end_turn sin tool terminal — se insiste una vez (vuelta ${round})`, {
            'ia.round': round,
            'ia.response.blocks': describeBlocks(data.content),
          })
          messages = withAssistantThenUser(
            messages,
            data.content,
            `Para terminar tu turno tenés que llamar a una de estas tools: ${terminalTools.map((tool) => tool.name).join(', ')}.`,
          )
          continue
        }
        const text = data.content.find((block) => block.type === 'text')?.text ?? ''
        return { outcome: opts.resolveOutcome?.(text) ?? 'success', summary: text }
      }

      if (data.stop_reason === 'pause_turn') {
        // El modelo se pausó a MITAD de turno — no es una pausa entre turnos (eso sería
        // `end_turn`/`tool_use` normal), es el mecanismo que usa la API para runs largos con
        // tools server-side (MCP remoto, extended thinking): el turno sigue, así que se
        // reenvía la respuesta TAL CUAL, sin nada detrás (la doc de server tools: un texto
        // cerraría el turno). Una llamada MCP que quedó sin result la corre la API al retomar;
        // una segunda pausa se suma al mismo turno. Tiene su propio tope
        // (`maxPauseTurnRetries`): una pausa no es una vuelta de tools, pero tampoco puede
        // repetirse sin fin.
        if (pauses >= cfg.maxPauseTurnRetries) {
          throw new Error(
            `AnthropicProvider(${opts.id}): superó maxPauseTurnRetries (${cfg.maxPauseTurnRetries}) sin converger`,
          )
        }
        pauses++
        this.log.info(`pause_turn — se retoma el turno (${pauses}/${cfg.maxPauseTurnRetries})`, {
          'ia.round': round,
          'ia.pauses': pauses,
          'ia.response.blocks': describeBlocks(data.content),
        })
        messages = withAssistant(messages, data.content)
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
      // La traza y `onToolResult` ven el resultado entero; a la conversación entra recortado.
      const toolResults = (
        await Promise.all(toolUseBlocks.map((block) => this.executeTool(block, tools)))
      ).map((result) => ({
        ...result,
        content: clipToolResult(result.content, cfg.maxToolResultChars),
      }))
      // Una tool terminal que devolvió OK (`submit_<salida>` validado) cierra el turno ahí: no
      // hace falta otra vuelta a la API para que el modelo diga "listo".
      const submitted = toolUseBlocks.some((block, index) => {
        const tool = ctx.tools.find((candidate) => candidate.name === block.name)
        const result = toolResults[index] as { is_error?: boolean } | undefined
        return tool?.terminal === true && result?.is_error !== true
      })
      if (submitted) {
        const text = data.content.find((block) => block.type === 'text')?.text ?? ''
        // La conversación con los resultados de esta vuelta: la que se retoma si la terminal
        // fue una espera (`wait_for_event`).
        const conversation: AnthropicMessage[] = [
          ...withAssistant(messages, data.content),
          { role: 'user', content: toolResults },
        ]
        return { outcome: 'success', summary: text, conversation }
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
      // El turno tal cual —una llamada MCP sin result la corre la API al recibir esto— y detrás
      // SÓLO los `tool_result`.
      messages = [...withAssistant(messages, data.content), { role: 'user', content: toolResults }]
      // Si el proceso muere acá, se retoma desde esta vuelta.
      ctx.saveConversation?.(messages)
    }
  }

  /**
   * Las tools de la corrida. Las de los MCP van diferidas (`defer_loading` + la búsqueda regex)
   * salvo `eagerMcpTools`: el catálogo de GitHub solo son decenas de tools. Con `connector` las
   * declara Anthropic (`mcp_toolset`); con `client` se listan acá y se ejecutan como las del
   * agente. Un MCP que no responde se loguea y el agente corre sin él.
   */
  private async runTools(ctx: ProviderRunContext, cfg: ResolvedRunConfig): Promise<RunTools> {
    const endpoints = mcpEndpoints(ctx.mcpServers)
    const defer = endpoints.length > 0 && !cfg.eagerMcpTools
    const asApi = (tool: Tool, deferred = false) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(deferred ? { defer_loading: true } : {}),
    })
    const own = ctx.tools.map((tool) => asApi(tool))
    const search = defer ? [TOOL_SEARCH] : []

    if (endpoints.length === 0 || cfg.mcpTransport === 'connector') {
      const toolsets = endpoints.map((endpoint) => ({
        type: 'mcp_toolset',
        mcp_server_name: endpoint.id,
        ...(defer ? { default_config: { defer_loading: true } } : {}),
      }))
      return {
        tools: ctx.tools,
        apiTools: [...search, ...own, ...toolsets],
        ...(endpoints.length > 0 ? { connector: endpoints } : {}),
      }
    }

    const fetchImpl = this.options.mcpFetchImpl
    const loaded = await loadMcpTools(endpoints, fetchImpl ? { fetchImpl } : {})
    for (const failure of loaded.failures) {
      this.log.warn(`mcp "${failure.server}" no respondió: el agente corre sin él`, {
        'ia.mcp.server': failure.server,
        'ia.mcp.error': failure.error,
      })
    }
    const searchable = defer && loaded.tools.length > 0
    return {
      tools: [...ctx.tools, ...loaded.tools],
      apiTools: [
        ...(searchable ? [TOOL_SEARCH] : []),
        ...own,
        ...loaded.tools.map((tool) => asApi(tool, searchable)),
      ],
    }
  }

  @traced(chatTrace)
  private async send(
    body: ChatRequest,
    round: number,
    sendOptions: AnthropicSendOptions,
  ): Promise<AnthropicMessagesResponse> {
    try {
      return await this.client.send(body, sendOptions)
    } catch (err) {
      // No se maneja: se le suma al log la forma de la conversación rechazada y sigue subiendo.
      logRejectedRequest(this.log, err, body, round)
      throw err
    }
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
