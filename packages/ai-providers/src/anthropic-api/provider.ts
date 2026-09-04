import { randomUUID } from 'node:crypto'
// Anthropic API provider — direct fetch, agentic tool loop, config-driven
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_WORKSPACE_PLAN, type McpServers, McpServersSchema } from '@ia-flow/shared'
import type { WorkspacePlan, WorkspaceRequest } from '@ia-flow/shared'
import { z } from 'zod'
import type {
  IAgentProvider,
  LoadProviderConfig,
  ProviderInput,
  ProviderOutput,
  ToolContext,
  ToolExecutionPort,
  WorkspaceProvisionerPort,
} from '../contract.js'
import { resolveStepSettings } from '../contract.js'
import { buildAnthropicHeaders, requestAnthropicApiWithRetry } from './auth.js'

/** Distinct error type for "the upstream provider stalled / reset / timed
 *  out on its own" — as opposed to "the operator (or the polling divergence
 *  gate) aborted us via AbortController". */
export class UpstreamAbortError extends Error {
  override name = 'UpstreamAbortError'
}

// Per-agent providerConfig shape for this provider. Kept private to the
// provider file so shared/ stays agnostic. Strict → extra fields (e.g.
// terminal flags) are rejected at runtime.
const AnthropicApiAgentConfigSchema = z
  .object({
    model: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    taskBudgetTokens: z.number().int().min(20000).optional(),
    maxPauseTurnRetries: z.number().int().min(0).max(20).optional(),
    retryTruncatedToolUse: z.boolean().optional(),
    // Forces extended thinking to `{ type: 'enabled', budget_tokens }` for
    // this agent — the fixed-budget mode, as opposed to the `adaptive`
    // default in DEFAULT_ANTHROPIC_SETTINGS which manages its own budget.
    // Anthropic requires budget_tokens >= 1024; the fetchApi closure also
    // clamps it below the effective max_tokens per-call (see there).
    thinkingBudgetTokens: z.number().int().min(1024).optional(),
    // Reintentos ante 429/5xx/529 y errores de conexión — ver
    // requestAnthropicApiWithRetry (auth.ts). Default: cfg.maxRetries, y si
    // tampoco está seteado, 3.
    maxRetries: z.number().int().min(0).max(10).optional(),
    mcpServers: McpServersSchema.optional(),
    fileSimplifierEnabled: z.boolean().optional(),
    // Por default las tools de cada MCP van DIFERIDAS: el request declara el
    // toolset con `defer_loading` y una tool de búsqueda, y el modelo carga
    // sólo las que necesita. Un MCP como el de GitHub anuncia decenas de
    // schemas que pesaban en cada vuelta del loop sin usarse. `true` apaga
    // eso y carga todo el catálogo desde el primer request — para un agente
    // que usa el MCP entero o cuyo prompt no lo prepara para buscar.
    eagerMcpTools: z.boolean().optional(),
  })
  .strict()

// Maps our unified McpServers map → the shape Anthropic Messages API expects
// in `mcp_servers[]`. Stdio entries are dropped (not supported remotely).
function toApiMcpServers(
  servers: McpServers | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!servers) return undefined
  const out: Array<Record<string, unknown>> = []
  for (const [name, srv] of Object.entries(servers)) {
    if (!('url' in srv)) continue
    const entry: Record<string, unknown> = { name, type: 'url', url: srv.url }
    if (srv.authorizationToken) entry.authorization_token = srv.authorizationToken
    // NOTE: Anthropic's mcp_servers schema does not accept a `headers` field.
    // Auth must go via `authorization_token`. If the ia-flow config only carries
    // headers, extract a Bearer token so the API call still authenticates.
    else if (srv.headers?.Authorization?.startsWith('Bearer ')) {
      entry.authorization_token = srv.headers.Authorization.slice('Bearer '.length)
    }
    out.push(entry)
  }
  return out.length > 0 ? out : undefined
}

function parseAgentConfig(raw: unknown): z.infer<typeof AnthropicApiAgentConfigSchema> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = AnthropicApiAgentConfigSchema.safeParse(raw)
  return r.success ? r.data : undefined
}

/**
 * Consumes an Anthropic Messages API SSE stream and reassembles it into the
 * same shape as a non-streaming response body (`{ content, stop_reason, ... }`)
 * so callers don't need to know the request was ever streamed.
 *
 * We stream (rather than wait for one giant JSON response) because a
 * non-streaming request that runs long — extended thinking, remote MCP tool
 * round-trips executed server-side within the same call — sits on an idle
 * connection with no bytes flowing, and gets reset upstream well before the
 * model is done (see UpstreamAbortError below). Streaming keeps bytes
 * flowing continuously, so it survives the same generation without tripping
 * an idle-connection timeout.
 */
async function readAnthropicSseStream(
  res: Response,
  log: AnthropicApiProviderDeps['log'],
  logCtx: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!res.body) throw new Error('Anthropic API streaming response had no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const message: Record<string, unknown> = { content: [] }
  const blocks: Array<Record<string, unknown>> = []
  const pendingToolJson: string[] = []

  const applyEvent = (eventType: string, data: string) => {
    const evt = JSON.parse(data)
    switch (eventType) {
      case 'message_start':
        Object.assign(message, evt.message)
        message.content = []
        break
      case 'content_block_start': {
        const idx = evt.index as number
        blocks[idx] = { ...evt.content_block }
        // Any block that streams its input via input_json_delta starts with
        // an `input` field already present — not just client-executed
        // `tool_use`, but also remote-MCP `mcp_tool_use` (see
        // toApiMcpServers above). `mcp_tool_result` blocks (server-computed,
        // no `input`) fall through untouched.
        if ('input' in blocks[idx]) pendingToolJson[idx] = ''
        break
      }
      case 'content_block_delta': {
        const idx = evt.index as number
        const block = blocks[idx]
        const delta = evt.delta
        if (!block || !delta) break
        if (delta.type === 'text_delta') block.text = ((block.text as string) ?? '') + delta.text
        else if (delta.type === 'thinking_delta')
          block.thinking = ((block.thinking as string) ?? '') + delta.thinking
        else if (delta.type === 'signature_delta')
          block.signature = ((block.signature as string) ?? '') + delta.signature
        else if (delta.type === 'input_json_delta')
          pendingToolJson[idx] = (pendingToolJson[idx] ?? '') + delta.partial_json
        break
      }
      case 'content_block_stop': {
        const idx = evt.index as number
        const block = blocks[idx]
        if (block && pendingToolJson[idx] !== undefined) {
          try {
            block.input = pendingToolJson[idx] ? JSON.parse(pendingToolJson[idx]) : {}
          } catch {
            block.input = {}
          }
        }
        // Log remote-MCP tool calls/results the moment each block finishes
        // streaming, instead of waiting for the whole message to complete —
        // see logMcpToolCall/logMcpToolResult below. Without this, a long
        // (or truncated) response with many server-side MCP round-trips
        // logs them all in one synchronous burst at the very end, so the
        // Ejecuciones tab shows them bunched under one timestamp instead of
        // spread across the run.
        if (block?.type === 'mcp_tool_use') {
          logMcpToolCall(log, logCtx, block)
        } else if (block?.type === 'mcp_tool_result') {
          const toolUseBlock = blocks.find(
            (b) => b?.type === 'mcp_tool_use' && b.id === block.tool_use_id,
          )
          if (toolUseBlock) logMcpToolResult(log, logCtx, toolUseBlock, block)
        }
        break
      }
      case 'message_delta':
        if (evt.delta) Object.assign(message, evt.delta)
        if (evt.usage) message.usage = { ...(message.usage as object), ...evt.usage }
        break
      case 'error':
        throw new Error(`Anthropic API stream error: ${JSON.stringify(evt.error ?? evt)}`)
      default:
        // message_stop, ping — nothing to accumulate
        break
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const raw of events) {
      if (!raw.trim()) continue
      let eventType = 'message'
      let data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) eventType = line.slice('event:'.length).trim()
        else if (line.startsWith('data:')) data += line.slice('data:'.length).trim()
      }
      if (data) applyEvent(eventType, data)
    }
  }

  message.content = blocks
  return message
}

/**
 * Remote MCP tool calls (`mcp_tool_use` / `mcp_tool_result`) never reach
 * `executeLoop`'s own tool_use loop — Anthropic resolves them server-side
 * within the same response, so the engine has nothing to execute and never
 * fires its `onToolCall`/`onToolResult` callbacks for them. Without this,
 * they're invisible in the Ejecuciones tab (its tool-call cards are built
 * client-side from `tool.call`/`tool.result` log lines keyed by
 * `toolUseId` — see apps/web's ExecutionsSection.vue). Emitting the same
 * event shape here, keyed the same way, makes MCP tool calls show up in
 * that UI with no frontend change.
 */
function logMcpToolCall(
  log: AnthropicApiProviderDeps['log'],
  logCtx: Record<string, unknown>,
  block: Record<string, unknown>,
): void {
  const tool = `${block.server_name}:${block.name}`
  log.info(
    { event: 'tool.call', ...logCtx, tool, toolUseId: block.id, input: block.input },
    'Tool call',
  )
}

function logMcpToolResult(
  log: AnthropicApiProviderDeps['log'],
  logCtx: Record<string, unknown>,
  toolUseBlock: Record<string, unknown>,
  resultBlock: Record<string, unknown>,
): void {
  const tool = `${toolUseBlock.server_name}:${toolUseBlock.name}`
  // result.content can also be a plain string — only array blocks carry
  // per-block `type`/`text` to filter/map over.
  const resultContent = resultBlock.content
  const contentBlocks: Array<Record<string, unknown>> = Array.isArray(resultContent)
    ? resultContent
    : []
  const text = contentBlocks
    .filter((c) => c.type === 'text')
    .map((c) => c.text as string)
    .join('')
  log.info(
    {
      event: 'tool.result',
      ...logCtx,
      tool,
      toolUseId: resultBlock.tool_use_id,
      result: (resultBlock.is_error ? '[error] ' : '') + text.slice(0, 500),
    },
    'Tool result',
  )
}

/** Batch fallback for the non-streaming (`res.json()`) path, where the
 * whole response arrives at once and there's no per-block stream event to
 * hook into. */
function logMcpToolActivity(
  log: AnthropicApiProviderDeps['log'],
  logCtx: Record<string, unknown>,
  content: Array<Record<string, unknown>>,
): void {
  for (const block of content) {
    if (block.type !== 'mcp_tool_use') continue
    logMcpToolCall(log, logCtx, block)
    const result = content.find((b) => b.type === 'mcp_tool_result' && b.tool_use_id === block.id)
    if (result) logMcpToolResult(log, logCtx, block, result)
  }
}

function authLabel(): string {
  if (Bun.env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN'
  if (Bun.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY'
  return 'none'
}

export interface AnthropicApiProviderDeps {
  toolExecution: ToolExecutionPort
  loadProviderConfig: LoadProviderConfig
  /**
   * Prepara el terreno del run (worktree aislado + scopes). Opcional: sin
   * esto el provider corre con los paths que ya le llegan en el input, que
   * es lo que hace un host sin repos locales (tests, o un agent-host pelado).
   */
  workspace?: WorkspaceProvisionerPort
  /** Minimal logger, matching the shape of `createLogger('anthropic-api')`. */
  log: {
    info: (obj: object, msg?: string) => void
    debug: (obj: object, msg?: string) => void
    warn: (obj: object, msg?: string) => void
    error: (obj: object, msg?: string) => void
  }
  /** Directory context dumps are written to. Defaults to
   *  `$IA_FLOW_LOG_DIR/contexts`, else `$IA_FLOW_CONFIG_DIR/logs/contexts`,
   *  else `~/.config/ia-flow/logs/contexts` — same fallback chain as before
   *  the extraction, just resolved by the caller instead of read from env
   *  directly, so this package stays free of `IA_FLOW_*` env conventions. */
  contextLogDir?: string
  /** Skips context dumps — the caller (apps/server) sets this under `bun
   *  test` so the suite running the provider many times with stubbed fetch
   *  doesn't flood the log dir with junk files. */
  skipContextLog?: boolean
}

async function logContext(
  deps: AnthropicApiProviderDeps,
  runId: string,
  taskTitle: string,
  requestBody: object,
  responseText: string,
): Promise<void> {
  if (deps.skipContextLog) return
  const logsDir =
    deps.contextLogDir ?? join(Bun.env.HOME ?? '', '.config', 'ia-flow', 'logs', 'contexts')
  try {
    await mkdir(logsDir, { recursive: true })
    const slug = taskTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(logsDir, `${ts}-${slug}.md`)
    const content = [
      `# ${taskTitle}`,
      `_${new Date().toISOString()}_ · runId: ${runId}`,
      '',
      '## Request',
      '```json',
      JSON.stringify(requestBody, null, 2),
      '```',
      '',
      '## Response',
      '```',
      responseText,
      '```',
    ].join('\n')
    await writeFile(path, content, 'utf-8')
    deps.log.debug({ event: 'agent.context_logged', runId, path }, 'Context logged')
  } catch (e) {
    deps.log.warn({ event: 'agent.context_log_failed', runId, err: e }, 'Failed to log context')
  }
}

export class AnthropicApiProvider implements IAgentProvider {
  readonly id = 'anthropic-api'
  readonly kind = 'sync' as const
  readonly name = 'Claude API (headless)'
  readonly description =
    'Direct fetch to Anthropic API. Supports streaming + thinking. All config via providers.json.'

  constructor(private readonly deps: AnthropicApiProviderDeps) {}

  /** Delega en el provisioner inyectado — es el que sabe de git y de disco.
   *  Sin provisioner, el engine se queda con lo que ya sabía. */
  async prepareWorkspace(req: WorkspaceRequest): Promise<WorkspacePlan> {
    const provisioner = this.deps.workspace
    if (!provisioner) return EMPTY_WORKSPACE_PLAN
    return provisioner.prepare(req)
  }

  async run(input: ProviderInput): Promise<ProviderOutput> {
    const { toolExecution, loadProviderConfig, log } = this.deps
    const deps = this.deps

    // Prefer the orchestrator-supplied runId so the execution_logs row and
    // all our log lines share the same correlation key. Falls back to a
    // local id only when called outside the orchestrator (tests).
    const runId = input.runId ?? randomUUID().slice(0, 8)
    const logCtx = {
      runId,
      agent: input.agentId,
      projectId: input.projectId,
      taskId: input.taskId,
      task: input.taskTitle,
    }

    const config = await loadProviderConfig()
    const { settings: cfg } = resolveStepSettings(input.step, config)

    // Per-agent override — validated against this provider's private schema.
    const pc = parseAgentConfig(input.providerConfig)

    const resolvedModel = pc?.model ?? cfg.model
    const resolvedMaxTokens = pc?.maxTokens ?? cfg.maxTokens ?? 32000
    const resolvedEffort = pc?.effort ?? cfg.effort
    const resolvedTaskBudget = pc?.taskBudgetTokens ?? cfg.taskBudgetTokens
    const resolvedMaxPauseTurnRetries = pc?.maxPauseTurnRetries ?? cfg.maxPauseTurnRetries
    const resolvedRetryTruncatedToolUse =
      pc?.retryTruncatedToolUse ?? cfg.retryTruncatedToolUse ?? false
    const resolvedThinkingBudgetTokens = pc?.thinkingBudgetTokens
    const resolvedMaxRetries = pc?.maxRetries ?? cfg.maxRetries ?? 3

    const resolvedMcpServers = pc?.mcpServers ?? cfg.mcpServers
    const apiMcpServers = toApiMcpServers(resolvedMcpServers)
    const deferMcpTools = apiMcpServers !== undefined && pc?.eagerMcpTools !== true

    // Betas fijas del agente (`cfg.anthropicBeta`, editable vía
    // providers.json) más las que este request activa condicionalmente.
    const extraBetas: string[] = []
    if (resolvedTaskBudget != null) extraBetas.push('task-budgets-2026-03-13')
    if (apiMcpServers) extraBetas.push('mcp-client-2025-11-20')

    // UN solo breakpoint de cache, en el ÚLTIMO bloque.
    //
    // El caching de la API es prefix match: el breakpoint cachea todo lo que
    // viene ANTES, así que marcar cada bloque no compra nada — y cuesta. El
    // tope es de 4 `cache_control` por request, y marcando uno por bloque ese
    // presupuesto lo consume la cantidad de entradas de `systemPrompts` (las
    // del proyecto MÁS las del agente): un roster que mueve su prompt estable
    // al system —que es exactamente donde tiene que estar para cachearse—
    // llega a 5 bloques sin darse cuenta y el request se cae con 400.
    //
    // Con un breakpoint al final, la cantidad de bloques deja de importar y
    // quedan 3 libres para lo que venga (tools, un breakpoint en messages).
    const allSystemBlocks = [...(input.systemPromptBlocks ?? []), ...cfg.systemPrompt]
    const systemBlocks = allSystemBlocks.map((block, i) =>
      i === allSystemBlocks.length - 1
        ? { ...block, cache_control: { type: 'ephemeral' as const } }
        : { ...block },
    )

    const headers = buildAnthropicHeaders({
      betas: cfg.anthropicBeta,
      extraBetas,
      version: cfg.anthropicVersion,
    })

    // `input.policy.toolNames` is typed as a Set (CompiledPolicy, see
    // packages/tools/src/contract.ts) for local providers. A remote run
    // (RemoteAgentProvider → apps/agent-host) sends it as a plain
    // array instead — JSON has no Set type, so RemoteAgentProvider converts
    // it before JSON.stringify to survive the wire. Accept either shape
    // here and rebuild a real Set before anything calls `.has()` on it
    // (engine.ts's resolveExecutableTool) or spreads it. Defensive against
    // a raw `{}` too (what an unconverted Set collapses to over JSON) —
    // a client that skips the array conversion gets an empty allow-list
    // instead of a crash.
    const rawToolNames = input.policy?.toolNames
    const toolNamesIterable =
      Array.isArray(rawToolNames) || rawToolNames instanceof Set ? rawToolNames : []
    const policy = input.policy
      ? { ...input.policy, toolNames: new Set(toolNamesIterable) }
      : input.policy

    // Single-pass resolution: filter by kind ('sync' → drops async-only
    // tools) and apply the compiled `toolNames` allow-list. Internal tools
    // are always kept regardless. `policy.toolNames` is always the
    // authoritative source — it's compiled straight from the agent's
    // `tools[]`, so there's no separate legacy list to reconcile.
    const toolDefs = toolExecution.getToolDefinitions({
      providerKind: 'sync',
      toolNames: policy ? [...policy.toolNames] : [],
      selectableExits: input.selectableExits,
      outputFields: input.outputFields,
    })

    const toolCtx: ToolContext = {
      repoPaths: input.repoPaths ?? {},
      sourceContext: input.sourceToolContext,
      fileSimplifierEnabled: pc?.fileSimplifierEnabled,
      // Absolute paths write/edit/exec tools are allowed to touch. Fed by
      // the WorkspaceManager for implement-step runs; undefined means "no
      // writable zones" and write tools must refuse.
      writePaths: input.writePaths,
      // Propagate the task id so tools that need to identify the active
      // run without asking the agent (e.g. `workspace_reset` accepting an
      // empty `{}` input) can read it from the context.
      taskId: input.taskId,
      // Identidad del namespace de las tools `memory_*`. Sale del input, no
      // del modelo: es lo que impide que un agente escriba en la memoria de
      // otro nombrándola.
      agentId: input.agentId,
      projectId: input.projectId,
      // El roster del proyecto, que viaja en el WorkspaceRequest (`repos` ahí
      // es `projectRepos` entero, no sólo los de la tarea) y por lo tanto
      // sobrevive el salto a un agent-host remoto.
      projectRepos: input.workspace?.repos.map((r) => ({
        name: r.name,
        githubOwner: r.githubOwner,
        githubRepo: r.githubRepo,
      })),
      // Freno de la cadena de delegación, para `run_agent`.
      agentDepth: input.agentDepth,
      // Compiled policy. `bash_run` reads its `bashRun` allow/deny patterns
      // from here; no entry means bash_run refuses everything.
      policy,
      // Lets the tool dispatcher (executeLoop) refuse a tool_use for a name
      // that isn't offered to sync providers (e.g. the async-only
      // complete_task/fail_task) even if the model emits one anyway — see
      // resolveExecutableTool in packages/tools/src/engine.ts.
      providerKind: 'sync',
    }

    log.info(
      {
        event: 'agent.start',
        ...logCtx,
        model: resolvedModel,
        auth: authLabel(),
        tools: toolDefs.map((t) => t.name),
        repos: Object.keys(toolCtx.repoPaths),
        writePaths: toolCtx.writePaths ?? [],
        mcpServers: apiMcpServers ? apiMcpServers.map((s) => s.name) : [],
        deferMcpTools,
      },
      'Agent run started',
    )
    log.debug(
      { event: 'agent.prompt', ...logCtx, system: systemBlocks, userPrompt: input.prompt },
      'Initial request context',
    )

    let apiCallCount = 0

    const fetchApi = async (messages: any[], overrides?: { bumpMaxTokens?: boolean }) => {
      apiCallCount++
      const iter = apiCallCount
      // Streamed by default: a non-streaming request that runs long
      // (extended thinking, remote MCP tool round-trips executed
      // server-side in the same call) sits idle with no bytes flowing and
      // gets reset upstream before the model finishes. Streaming keeps
      // bytes flowing so it survives the same generation time. Honors the
      // existing `stream` config knob (AnthropicApiSettings) instead of
      // hardcoding — defaults to true via DEFAULT_ANTHROPIC_SETTINGS.
      const useStream = cfg.stream ?? true
      // `bumpMaxTokens` (executeLoop's max_tokens/tool_use retry) doubles
      // the budget for this one call only — capped well under known model
      // ceilings. `Math.max` with the original guards the case where
      // `resolvedMaxTokens` is already >= the 128000 cap: without it,
      // `Math.min(resolvedMaxTokens * 2, 128000)` would come back <=
      // resolvedMaxTokens, i.e. the "bump" would silently shrink or hold
      // the budget instead of raising it. If the double still exceeds what
      // the model actually allows, the API 400s, which surfaces as a
      // normal thrown error same as any other bad request; no worse than
      // the truncated tool_use it was trying to recover from.
      const effectiveMaxTokens = overrides?.bumpMaxTokens
        ? Math.max(resolvedMaxTokens, Math.min(resolvedMaxTokens * 2, 128000))
        : resolvedMaxTokens
      const body: Record<string, unknown> = {
        model: resolvedModel,
        max_tokens: effectiveMaxTokens,
        system: systemBlocks,
        messages,
        stream: useStream,
        // Auto-cache A NIVEL REQUEST, además del breakpoint explícito al final
        // del system. Ése cubre el prefijo estable (tools + system); éste hace
        // que la API ponga un breakpoint en el último bloque cacheable de
        // `messages` y lo corra sola en cada vuelta. Sin él, un run de 30
        // vueltas re-pagaba el historial entero a precio pleno 30 veces — era
        // el 41% de cache hit del reviewer en el panel de salud. Compone con
        // el marker de system porque ése NO está en el último bloque del
        // request, y consume un solo slot de los 4.
        cache_control: { type: 'ephemeral' },
      }
      // mcp-client-2025-11-20 requires exactly one MCPToolset per server named
      // in mcp_servers — omitting it 400s. No per-tool allow/deny is
      // configured here (default_config/configs), so this preserves the
      // previous (deprecated mcp-client-2025-04-04) behavior of exposing
      // every tool the server advertises.
      //
      // Diferidas por default (ver `eagerMcpTools`): `default_config` vale
      // para todas las tools del server, y la tool de búsqueda es lo que le
      // permite al modelo encontrarlas. Las tools propias del engine NO se
      // difieren — son pocas, ya filtradas por el `tools[]` del agente, y la
      // API exige al menos una sin diferir. Las descubiertas se anexan al
      // final del contexto, así que el prefijo cacheado no se toca.
      const mcpToolsets = apiMcpServers?.map((s) => ({
        type: 'mcp_toolset',
        mcp_server_name: s.name,
        ...(deferMcpTools ? { default_config: { defer_loading: true } } : {}),
      }))
      const toolSearch = deferMcpTools
        ? [{ type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' }]
        : []
      const allTools = [...toolSearch, ...toolDefs, ...(mcpToolsets ?? [])]
      if (allTools.length > 0) body.tools = allTools
      // Per-agent `thinkingBudgetTokens` forces the fixed-budget `enabled`
      // mode instead of the provider-level default (usually `adaptive`,
      // which manages its own budget and doesn't take one). The API
      // requires budget_tokens < max_tokens — clamp below effectiveMaxTokens
      // (which itself can shift per-call via bumpMaxTokens) rather than
      // trusting the config value blindly; a config that would 400 every
      // single request (e.g. thinkingBudgetTokens == maxTokens) is a config
      // bug, not something a run should discover by failing in production.
      if (resolvedThinkingBudgetTokens != null) {
        const clampedThinkingBudget = Math.min(
          resolvedThinkingBudgetTokens,
          effectiveMaxTokens - 1024,
        )
        if (clampedThinkingBudget >= 1024) {
          body.thinking = { type: 'enabled', budget_tokens: clampedThinkingBudget }
        } else {
          log.warn(
            {
              event: 'agent.config_warning',
              ...logCtx,
              thinkingBudgetTokens: resolvedThinkingBudgetTokens,
              effectiveMaxTokens,
            },
            'thinkingBudgetTokens leaves no room under max_tokens — falling back to provider default',
          )
          if (cfg.thinking) body.thinking = cfg.thinking
        }
      } else if (cfg.thinking) {
        body.thinking = cfg.thinking
      }
      if (apiMcpServers) body.mcp_servers = apiMcpServers

      const outputConfig: Record<string, unknown> = {}
      if (resolvedEffort) outputConfig.effort = resolvedEffort
      if (resolvedTaskBudget != null)
        outputConfig.task_budget = { type: 'tokens', total: resolvedTaskBudget }
      if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig

      // El `body` completo va a `debug`, no a `info`: incluye TODO el
      // historial de mensajes y se re-emite en cada `iter`, así que su costo
      // en disco es cuadrático sobre la longitud del run — era la línea más
      // cara del daemon.log por lejos. En `info` queda la forma del request,
      // que es lo que se necesita para seguir un run sin reproducirlo.
      log.info(
        {
          event: 'api.request',
          ...logCtx,
          iter,
          messageCount: messages.length,
          model: body.model,
          maxTokens: body.max_tokens,
        },
        'Anthropic request',
      )
      log.debug({ event: 'api.request', ...logCtx, iter, body }, 'Anthropic request body')

      const t0 = Date.now()
      let res: Response
      try {
        res = await requestAnthropicApiWithRetry(body, {
          headers,
          signal: input.signal,
          maxRetries: resolvedMaxRetries,
          onRetry: (info) =>
            log.warn(
              {
                event: 'api.retry',
                ...logCtx,
                iter,
                attempt: info.attempt,
                maxRetries: info.maxRetries,
                delayMs: Math.round(info.delayMs),
                status: info.status,
                err: info.error instanceof Error ? info.error.message : info.error,
              },
              'Retrying Anthropic API request after transient error',
            ),
        })
      } catch (err) {
        const ms = Date.now() - t0
        const errMsg = err instanceof Error ? err.message : String(err)
        const errName = err instanceof Error ? err.name : undefined
        // If the caller aborted us (polling divergence gate / shutdown),
        // rethrow untouched — the orchestrator classifies it via the
        // shared controller.signal. Anything else is an upstream failure.
        if (input.signal?.aborted) throw err
        log.error(
          { event: 'api.abort', ...logCtx, iter, ms, errName, err: errMsg },
          'Anthropic fetch aborted upstream (network/stream stall)',
        )
        throw new UpstreamAbortError(`Anthropic API upstream abort after ${ms}ms: ${errMsg}`, {
          cause: err,
        })
      }

      if (!res.ok) {
        const ms = Date.now() - t0
        const text = await res.text()
        log.error(
          { event: 'api.response', ...logCtx, iter, status: res.status, ms, body: text },
          'Anthropic error response',
        )
        throw new Error(`Anthropic API ${res.status}: ${text}`)
      }

      // Headers arrived fine — read+reassemble the body next. A stall or
      // reset while the model is still generating throws here, not in the
      // fetch() try/catch above, so it needs its own classification.
      let json: Record<string, unknown>
      try {
        json = useStream ? await readAnthropicSseStream(res, log, logCtx) : await res.json()
      } catch (err) {
        const ms = Date.now() - t0
        const errMsg = err instanceof Error ? err.message : String(err)
        const errName = err instanceof Error ? err.name : undefined
        if (input.signal?.aborted) throw err
        log.error(
          { event: 'api.abort', ...logCtx, iter, ms, errName, err: errMsg },
          'Anthropic stream aborted upstream (network/stream stall)',
        )
        throw new UpstreamAbortError(`Anthropic API upstream abort after ${ms}ms: ${errMsg}`, {
          cause: err,
        })
      }
      const ms = Date.now() - t0
      // Mismo criterio que el request: el `body` entero a `debug`. En `info`
      // quedan stop_reason y usage, que son las dos cosas por las que se mira
      // una respuesta sin estar debuggeando (¿por qué cortó?, ¿cuánto gastó?).
      log.info(
        {
          event: 'api.response',
          ...logCtx,
          iter,
          status: res.status,
          ms,
          stopReason: json.stop_reason,
          usage: json.usage,
        },
        'Anthropic response',
      )
      log.debug({ event: 'api.response', ...logCtx, iter, body: json }, 'Anthropic response body')
      // Streaming path already logged MCP tool activity incrementally, per
      // block, inside readAnthropicSseStream's content_block_stop handler.
      if (!useStream) {
        logMcpToolActivity(log, logCtx, (json.content as Array<Record<string, unknown>>) ?? [])
      }
      return json
    }

    const {
      text: rawText,
      iters,
      stopReason,
      truncated,
      rawResponse,
      checkpoint,
      usage,
      toolCalls,
      toolErrors,
      toolBreakdown,
    } = await toolExecution.executeLoop(
      fetchApi,
      // Un run que se reanuda entra con la conversación que el checkpoint
      // guardó, no con el prompt: retomar desde el prompt perdería todo lo
      // que el agente ya había averiguado, que es justamente lo que la pausa
      // existe para conservar.
      (input.resumeMessages as Array<{ role: 'user' | 'assistant'; content: unknown }>) ?? [
        { role: 'user', content: input.prompt },
      ],
      toolCtx,
      {
        onToolCall: (name, inp, toolUseId) =>
          log.info(
            { event: 'tool.call', ...logCtx, tool: name, toolUseId, input: inp },
            'Tool call',
          ),
        onToolResult: (name, result, toolUseId) =>
          log.info(
            {
              event: 'tool.result',
              ...logCtx,
              tool: name,
              toolUseId,
              result: result.slice(0, 500),
            },
            'Tool result',
          ),
        signal: input.signal,
        logContext: logCtx,
        maxPauseTurnRetries: resolvedMaxPauseTurnRetries,
        retryTruncatedToolUse: resolvedRetryTruncatedToolUse,
        // Se pasan tal cual vinieron en el input: el provider no sabe de dónde
        // salen los mensajes (Slack, la API, un test) ni dónde se marcan
        // entregados — sólo que el loop los tiene que drenar.
        drainMessages: input.drainMessages,
        onMessagesDelivered: input.onMessagesDelivered,
        saveCheckpoint: input.saveCheckpoint,
      },
    )

    log.info(
      {
        event: 'agent.complete',
        ...logCtx,
        iters,
        stopReason,
        truncated,
        usage,
        toolCalls,
        toolErrors,
      },
      truncated ? 'Agent run truncated' : 'Agent run complete',
    )

    await logContext(
      deps,
      runId,
      input.taskTitle,
      { model: cfg.model, tools: toolDefs.map((t) => t.name) },
      rawText,
    )

    const cleaned = rawText
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim()
    return {
      content: cleaned,
      mode: 'api',
      truncated,
      stopReason,
      rawResponse,
      // Presente sólo cuando una tool pidió pausa. Quien lo recibe decide qué
      // hacer: el engine lo cuelga de la espera para poder reanudar.
      checkpoint,
      metrics: { usage, iters, toolCalls, toolErrors, toolBreakdown, model: resolvedModel },
    }
  }
}
