// Tool registry + agentic execution loop
// Add new tools by implementing Tool<TInput> and calling registerTool()
import type { ProviderKind } from '@ia-flow/ai-providers'
import { DEFAULT_MAX_PAUSE_TURN_RETRIES } from '@ia-flow/shared'
import { HISTORY_COMPACTION_PROMPT } from './compaction-prompt.js'
import type {
  LoopOptions,
  LoopResult,
  LoopUsage,
  Tool,
  ToolContext,
  ToolDefinitionsOptions,
} from './contract.js'
import { askHaiku, haikuAuthHeader } from './haiku.js'
import { createLogger } from './logger.js'

const log = createLogger('tool-loop')

const ALL_KINDS: ProviderKind[] = ['sync', 'async']

const registry = new Map<string, Tool>()
// Alias → canonical name. Populated at `registerTool` time so lookups from
// legacy `AgentDefinition.tools[]` (e.g. `run_command` → `bash_run`) resolve
// without walking the whole registry. A single alias may only point to one
// canonical tool; duplicate registration overwrites (last-write-wins), which
// is fine because the rename map is deterministic.
const aliasIndex = new Map<string, string>()

function toolAppliesTo(t: Tool, kind: ProviderKind): boolean {
  return (t.providerKinds ?? ALL_KINDS).includes(kind)
}

export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool)
  if (tool.aliases) {
    for (const alias of tool.aliases) aliasIndex.set(alias, tool.name)
  }
}

/**
 * Saca una tool del registry.
 *
 * Existe para las tools que salen de la CONFIG (`applyEditableTools`), que se
 * pueden borrar en caliente: sin esto la entrada sobrevivía con su `execute`
 * intacto y un agente que la tuviera en su `tools[]` la seguía corriendo hasta
 * el próximo reinicio, aunque la UI ya la mostrara borrada.
 *
 * Los alias que apuntaban a ella se van con ella: un alias colgado resolvería
 * a un nombre que ya no existe.
 */
export function unregisterTool(name: string): boolean {
  for (const [alias, canonical] of aliasIndex) {
    if (canonical === name) aliasIndex.delete(alias)
  }
  return registry.delete(name)
}

/**
 * Resolve legacy tool names (aliases) to their canonical ids. Unknown names
 * pass through unchanged so callers can still validate/warn on them
 * downstream. Deduplicates the result — an agent that lists both the alias
 * and the canonical name would otherwise get a duplicate.
 */
export function resolveAliases(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    const canonical = aliasIndex.get(name) ?? name
    if (seen.has(canonical)) continue
    seen.add(canonical)
    out.push(canonical)
  }
  return out
}

/** All registered tools. Used by `/api/tools` and the category endpoint. */
export function getAllTools(): Tool[] {
  return [...registry.values()]
}

export function getToolDefinitions(opts?: ToolDefinitionsOptions): Array<{
  name: string
  description: string
  input_schema: object
}> {
  return resolveTools(opts).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.specialize?.(opts) ?? t.input_schema,
  }))
}

/** Filter helper shared by both sync (API tool defs) and async (curl
 *  appendix) resolution paths. Returns the full `Tool` objects so callers
 *  that need `execute`, `internal`, etc. don't lose those fields. */
export function resolveTools(opts?: ToolDefinitionsOptions): Tool[] {
  // `toolNames` distinguishes "no filter" (undefined — used by catalog/listing
  // callers that want everything) from "explicit allow-list, possibly empty"
  // (an array — used by real dispatch, where empty means the agent has no
  // tools at all beyond the internal lifecycle ones).
  const allowed = opts?.toolNames ? new Set(resolveAliases(opts.toolNames)) : null
  const kind = opts?.providerKind
  return [...registry.values()].filter((t) => {
    if (kind && !toolAppliesTo(t, kind)) return false
    if (t.hideWhen?.(opts)) return false
    if (t.internal) return true
    if (!allowed) return true
    return allowed.has(t.name)
  })
}

/**
 * Reparte nombres de tools según el disco sobre el que tienen que correr.
 *
 * Existe para el run de terminal detrás de un agent-host, que es el único
 * caso con DOS discos en juego: el CLI y el workspace viven en el agent-host,
 * y la fuente de issues, GitHub, Slack, la memoria y el registry de pending
 * tasks viven en el daemon. Hasta ahora todas las tools inyectadas salían por
 * un solo MCP apuntado al daemon, así que un `fs_write` de ese agente escribía
 * en la máquina equivocada — sin fallar, que es lo que lo hacía difícil de ver.
 *
 * Trabaja sobre NOMBRES y no sobre `Tool`s porque los dos consumidores
 * (`terminal/base.ts` al armar el `--mcp-config`) sólo tienen la lista de
 * nombres del agente. Un nombre que el registry no conoce se manda al daemon:
 * es el default seguro —ahí está el catálogo completo— y un alias viejo sigue
 * resolviendo como siempre.
 */
export function partitionToolsByDisk(toolNames: readonly string[]): {
  agentDisk: string[]
  daemon: string[]
} {
  const agentDisk: string[] = []
  const daemon: string[] = []
  for (const name of toolNames) {
    const canonical = registry.has(name) ? name : (aliasIndex.get(name) ?? name)
    if (registry.get(canonical)?.runsOn === 'agent-disk') agentDisk.push(name)
    else daemon.push(name)
  }
  return { agentDisk, daemon }
}

/**
 * Reemplaza la descripción de una tool ya registrada.
 *
 * Es lo ÚNICO que un override de configuración puede tocar de una built-in, y
 * la razón es que las otras tres cosas no se pueden cambiar sin romper algo:
 * el `name` es la clave que los agentes escriben en su `tools[]`, el
 * `input_schema` es contra lo que está compilado el `execute`, y el `execute`
 * es código.
 *
 * La descripción, en cambio, es prompt engineering: hoy afinarla exige un
 * deploy, y es justo el tuning que más se quiere hacer sin uno.
 *
 * Devuelve `false` si no existe — el llamador decide si eso es un error (una
 * override sobre una built-in removida en un update no lo es).
 */
export function setToolDescription(name: string, description: string): boolean {
  const tool = registry.get(name) ?? registry.get(aliasIndex.get(name) ?? '')
  if (!tool) return false
  tool.description = description
  return true
}

export function getTool(name: string): Tool | undefined {
  const direct = registry.get(name)
  if (direct) return direct
  const canonical = aliasIndex.get(name)
  return canonical ? registry.get(canonical) : undefined
}

/**
 * Resolve a tool for actual execution — the same allow-list + providerKind
 * rules `resolveTools` applies when building the definitions sent to the
 * model, but callable from a dispatcher that only has a `ToolContext` (no
 * `ToolDefinitionsOptions`). `resolveTools`/`getToolDefinitions` only gate
 * what's *offered*; they don't stop a model from emitting a `tool_use` for a
 * name it wasn't offered (a prompt can still tell it to, as
 * subscriptions-refiner's did with `complete_task` while running sync — see
 * the incident this was added for). Every tool-call dispatcher MUST resolve
 * through this instead of `getTool`/registry lookups directly, so a
 * disallowed name can never execute regardless of what the model asks for.
 *
 * `ctx.providerKind`/`ctx.policy` undefined ⇒ that check is skipped (ad-hoc
 * or test contexts that don't set them) — real dispatch paths always set
 * both.
 */
export function resolveExecutableTool(name: string, ctx: ToolContext): Tool | undefined {
  const tool = getTool(name)
  if (!tool) return undefined
  if (ctx.providerKind && !toolAppliesTo(tool, ctx.providerKind)) return undefined
  if (tool.internal) return tool
  if (!ctx.policy) return tool
  return ctx.policy.toolNames.has(tool.name) ? tool : undefined
}

// ─── Agentic loop ─────────────────────────────────────────────────────────
// Loops tool_use ↔ tool_result until the model returns end_turn. Runaway is
// bounded by `HARD_ITER_CAP` (a safety net, not a user-facing knob) and by
// the server-side `task_budget` when the caller opts in.

// Circuit breaker for a stuck model that never emits `end_turn`. Well above
// what any real task should need; the real stopping signal is task budget or
// `end_turn`.
const HARD_ITER_CAP = 500

type ApiMessage = { role: 'user' | 'assistant'; content: unknown }

// Per-call knobs `executeLoop` can ask the injected `fetchApi` closure to
// apply to ONE specific request, without the loop knowing how that closure
// builds its request body (model, max_tokens, tools, … all live in the
// caller — see AnthropicApiProvider.run's `fetchApi`).
type FetchApiOverrides = {
  /** Use a higher max_tokens for this call only — see the max_tokens/
   *  tool_use retry in executeLoop. */
  bumpMaxTokens?: boolean
}

// Compact history when it exceeds ~200k tokens (~800k chars). Uses Haiku to summarize
// all tool results into a "Key findings" block, preserving insights without raw bytes.
const COMPACTION_BUDGET_CHARS = 800_000

// Per-tool-result hard cap. Individual tools have their own limits (read_file
// ≤ 40k, grep_files ≤ 30 matches, list_dir non-recursive), but a defensive
// cap prevents a misbehaving or newly-added tool from ballooning the history
// past `COMPACTION_BUDGET_CHARS` in a single turn (run c6712c5d hit 5 MB
// across 5 tool_results despite tool-level limits — root cause unclear, so
// enforce a per-block ceiling here as belt-and-suspenders).
const MAX_TOOL_RESULT_BYTES = 100_000

// Cap on the raw API response snapshot attached to a truncated LoopResult
// (see `rawResponse` on the contract). A cut-short response can still carry
// a huge partial `content` block (e.g. a giant in-progress tool_use input);
// capping keeps that from ballooning the execution_log row it ends up in.
const RAW_RESPONSE_LOG_CAP = 50_000

function captureRawResponse(response: unknown): string {
  const json = JSON.stringify(response)
  return json.length > RAW_RESPONSE_LOG_CAP
    ? `${json.slice(0, RAW_RESPONSE_LOG_CAP)}\n[truncated at ${RAW_RESPONSE_LOG_CAP} chars — original ${json.length}]`
    : json
}

function logCompactionBreakdown(messages: ApiMessage[], historyBytes: number, runLog: typeof log) {
  const messageSizes = messages.map((m, i) => ({
    i,
    role: m.role,
    kind: Array.isArray(m.content)
      ? (m.content as any[]).map((b) => b?.type ?? typeof b).join(',')
      : typeof m.content,
    bytes: JSON.stringify(m.content).length,
  }))
  const top = [...messageSizes].sort((a, b) => b.bytes - a.bytes).slice(0, 3)
  runLog.info(
    { historyBytes, messageCount: messages.length, top },
    'compactHistory input breakdown',
  )
}

// Fallback compaction when Haiku isn't available: truncate tool results to
// 500 chars each instead of summarizing them.
function truncateToolResults(messages: ApiMessage[]): ApiMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
    return {
      ...msg,
      content: (msg.content as any[]).map((block) =>
        block.type === 'tool_result' &&
        typeof block.content === 'string' &&
        block.content.length > 500
          ? { ...block, content: block.content.slice(0, 500) + '\n[truncated]' }
          : block,
      ),
    }
  })
}

function collectToolResultTexts(messages: ApiMessage[]): string[] {
  const toolResults: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as any[]) {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        toolResults.push(block.content)
      }
    }
  }
  return toolResults
}

// Preserve the last complete assistant/tool_result pair so the model sees
// continuity (what it just tried + result) instead of restarting from
// scratch. Without this, the model re-issues the same exploratory tool
// calls forever because the collapsed history looks identical every turn.
function buildCompactionTail(messages: ApiMessage[]): ApiMessage[] {
  const tail: ApiMessage[] = []
  const last = messages[messages.length - 1]
  const secondLast = messages[messages.length - 2]
  if (
    last &&
    secondLast &&
    secondLast.role === 'assistant' &&
    last.role === 'user' &&
    Array.isArray(last.content) &&
    (last.content as any[]).every((b) => b?.type === 'tool_result')
  ) {
    tail.push(secondLast, last)
  }
  return tail
}

async function summarizeHistoryWithHaiku(
  messages: ApiMessage[],
  historyBytes: number,
  runLog: typeof log,
): Promise<ApiMessage[]> {
  const toolResults = collectToolResultTexts(messages)
  const userContent = toolResults.join('\n\n---\n\n').slice(0, 150_000)
  const t0 = Date.now()
  try {
    const {
      text: summary,
      usage,
      ms,
    } = await askHaiku({
      system: HISTORY_COMPACTION_PROMPT,
      user: userContent,
      maxTokens: 4096,
      scope: { tool: 'compactHistory', historyBytes, toolResultCount: toolResults.length },
      logger: runLog,
    })

    // Keep: initial prompt + summary of findings as a plain user turn.
    // The summary can't be a `tool_result` — there's no matching `tool_use`
    // in a preceding assistant message, so the API rejects it with
    // `unexpected tool_use_id`. Trailing assistant messages are dropped for
    // the same reason (they may hold `tool_use` blocks with no follow-up).
    const initial = messages.slice(0, 1)
    const summaryMsg: ApiMessage = {
      role: 'user',
      content: `Key findings from previous exploration:\n${summary}`,
    }
    const tail = buildCompactionTail(messages)
    const compacted: ApiMessage[] = [...initial, summaryMsg, ...tail]
    const afterBytes = JSON.stringify(compacted).length
    runLog.info(
      {
        ms,
        summaryBytes: summary.length,
        beforeBytes: historyBytes,
        afterBytes,
        ratio: afterBytes / Math.max(historyBytes, 1),
        usage,
      },
      'haiku compaction response',
    )
    return compacted
  } catch (e) {
    runLog.warn(
      { ms: Date.now() - t0, err: e instanceof Error ? e.message : String(e) },
      'haiku compaction threw, keeping history',
    )
    return messages
  }
}

async function compactHistory(
  messages: ApiMessage[],
  runLog: typeof log = log,
): Promise<ApiMessage[]> {
  const historyBytes = JSON.stringify(messages).length
  logCompactionBreakdown(messages, historyBytes, runLog)

  if (!haikuAuthHeader()) {
    runLog.warn({ historyBytes }, 'haiku compaction skipped: no auth — truncating tool results')
    return truncateToolResults(messages)
  }

  return summarizeHistoryWithHaiku(messages, historyBytes, runLog)
}

// Anthropic returns usage per response; the cache fields are absent on
// requests that didn't touch the cache. Missing/garbage values count as 0
// rather than NaN-poisoning the whole run's totals.
function accumulateUsage(acc: LoopUsage, raw: unknown): void {
  const u = raw as Record<string, unknown> | undefined | null
  if (!u || typeof u !== 'object') return
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  acc.inputTokens += num(u.input_tokens)
  acc.outputTokens += num(u.output_tokens)
  acc.cacheReadTokens += num(u.cache_read_input_tokens)
  acc.cacheCreationTokens += num(u.cache_creation_input_tokens)
}

// ─── executeLoop: per-stopReason handlers ──────────────────────────────────
// Immutable per-iteration facts every handler needs, bundled so extracting
// a branch doesn't mean threading a dozen individual params through it.
type LoopStepContext = {
  response: unknown
  contentBlocks: any[]
  stopReason: string
  iters: number
  metrics: () => Pick<LoopResult, 'usage' | 'toolCalls' | 'toolErrors' | 'toolBreakdown'>
  textOf: () => string
  messages: ApiMessage[]
  runLog: typeof log
  retryTruncatedToolUse: boolean
  maxPauseTurnRetries: number
}

// Mutable state that survives across iterations, threaded by reference so a
// handler's retry/pause bookkeeping is visible to the next loop turn.
type LoopState = {
  pauseTurnRetries: number
  toolUseRetried: boolean
  pausedText: string
}

type LoopStepDecision =
  | { action: 'return'; result: LoopResult }
  | { action: 'continue'; nextFetchOverrides?: FetchApiOverrides }

function truncatedResult(ctx: LoopStepContext, state: LoopState): LoopResult {
  return {
    ...ctx.metrics(),
    text: state.pausedText + ctx.textOf(),
    iters: ctx.iters,
    stopReason: ctx.stopReason,
    truncated: true,
    rawResponse: captureRawResponse(ctx.response),
  }
}

// Drops the corrupted (truncated) assistant turn and asks the next
// `fetchApi` call to use a higher max_tokens — the shared shape behind both
// max_tokens retry paths below (a client `tool_use` cut mid-stream, and an
// `mcp_tool_use` cut mid-stream).
function prepareMaxTokensRetry(
  messages: ApiMessage[],
  runLog: typeof log,
  logFields: Record<string, unknown>,
  warnMessage: string,
): FetchApiOverrides {
  messages.pop()
  runLog.warn(logFields, warnMessage)
  return { bumpMaxTokens: true }
}

function handleUnresolvedServerToolUse(ctx: LoopStepContext, state: LoopState): LoopStepDecision {
  if (ctx.retryTruncatedToolUse && !state.toolUseRetried && ctx.stopReason === 'max_tokens') {
    state.toolUseRetried = true
    const nextFetchOverrides = prepareMaxTokensRetry(
      ctx.messages,
      ctx.runLog,
      { stopReason: ctx.stopReason },
      'max_tokens cut off a server-tool_use block — retrying once with more tokens',
    )
    return { action: 'continue', nextFetchOverrides }
  }
  ctx.runLog.warn(
    { stopReason: ctx.stopReason },
    'assistant turn carries an unresolved server-tool call with no client tool_use to defer it — ending run instead of resending or checkpointing it',
  )
  return { action: 'return', result: truncatedResult(ctx, state) }
}

// `pause_turn`: the server-side sampling loop for server tools (remote MCP
// connectors, web search, …) hit its own iteration cap — default 10 per
// Anthropic request, independent of `task_budget` — and paused the turn to
// hand control back to us. Per Anthropic's docs
// (platform.claude.com/docs/en/build-with-claude/handling-stop-reasons), the
// correct continuation is resending the message list UNCHANGED: the caller
// already pushed the paused assistant turn, so simply looping back and
// re-calling `fetchApi(messages)` does exactly that. Bounded by
// `maxPauseTurnRetries` (DEFAULT_MAX_PAUSE_TURN_RETRIES unless the agent or
// the provider settings override it) so a model that keeps re-triggering the
// server-tool cap can't loop forever. The bound is what makes a non-zero
// default safe: with 0, a SINGLE pause — which any agent doing a handful of
// remote MCP round-trips in one turn hits routinely — killed the whole run as
// `truncated`, which is strictly worse than paying a resend whose history the
// API already has cached.
function handlePauseTurn(ctx: LoopStepContext, state: LoopState): LoopStepDecision {
  if (state.pauseTurnRetries < ctx.maxPauseTurnRetries) {
    state.pauseTurnRetries++
    state.pausedText += ctx.textOf()
    ctx.runLog.info(
      {
        stopReason: ctx.stopReason,
        pauseTurnRetries: state.pauseTurnRetries,
        maxPauseTurnRetries: ctx.maxPauseTurnRetries,
      },
      'pause_turn — resuming turn unchanged',
    )
    return { action: 'continue' }
  }
  return { action: 'return', result: truncatedResult(ctx, state) }
}

// `max_tokens` / `model_context_window_exceeded`: the response itself is
// partial (cut mid-generation), not a pause between server-tool rounds —
// resending unchanged won't recover it, so always treat as truncated...
// EXCEPT the one case Anthropic's docs call out as recoverable: the very
// last block is an in-progress `tool_use` whose JSON input got cut off
// mid-stream. Bounded to a single retry per run (not per-occurrence) so a
// model that keeps generating huge tool inputs can't inflate cost unbounded.
function handleMaxTokens(ctx: LoopStepContext, state: LoopState): LoopStepDecision {
  const lastBlock = ctx.contentBlocks[ctx.contentBlocks.length - 1]
  if (
    ctx.retryTruncatedToolUse &&
    !state.toolUseRetried &&
    ctx.stopReason === 'max_tokens' &&
    lastBlock?.type === 'tool_use'
  ) {
    state.toolUseRetried = true
    const nextFetchOverrides = prepareMaxTokensRetry(
      ctx.messages,
      ctx.runLog,
      { stopReason: ctx.stopReason, tool: lastBlock.name },
      'max_tokens cut off a tool_use block — retrying once with more tokens',
    )
    return { action: 'continue', nextFetchOverrides }
  }
  return { action: 'return', result: truncatedResult(ctx, state) }
}

type ToolBlockResult = {
  toolResult: { type: 'tool_result'; tool_use_id: string; content: string; is_error?: true }
  isError: boolean
}

async function executeToolBlock(
  block: any,
  loopCtx: ToolContext,
  runLog: typeof log,
  onToolCall: LoopOptions['onToolCall'],
  onToolResult: LoopOptions['onToolResult'],
): Promise<ToolBlockResult> {
  const tool = resolveExecutableTool(block.name, loopCtx)
  onToolCall?.(block.name, block.input, block.id)

  let result: string
  if (!tool) {
    result = `Error: tool '${block.name}' not found`
  } else {
    try {
      result = await tool.execute(block.input, loopCtx)
    } catch (e) {
      result = `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  if (result.length > MAX_TOOL_RESULT_BYTES) {
    runLog.warn(
      { tool: block.name, resultBytes: result.length, cap: MAX_TOOL_RESULT_BYTES },
      'tool result exceeds per-block cap — truncating',
    )
    result =
      result.slice(0, MAX_TOOL_RESULT_BYTES) +
      `\n[truncated at ${MAX_TOOL_RESULT_BYTES} bytes — original ${result.length}]`
  }

  // `Error:` is the prefix both failure paths above write (unknown tool, or
  // `execute` threw); a tool that returns its own error text without it
  // isn't counted, which is the conservative direction.
  const isError = result.startsWith('Error:')
  onToolResult?.(block.name, result, block.id)
  // `is_error` es lo que la API entiende como fallo; el prefijo `Error:` en
  // el texto es sólo para humanos y el modelo no lo distingue del contenido
  // de un resultado exitoso.
  return {
    toolResult: {
      type: 'tool_result',
      tool_use_id: block.id,
      content: result,
      ...(isError ? { is_error: true } : {}),
    },
    isError,
  }
}

// Executes all tool_use blocks of one turn in parallel — this invariant is
// load-bearing for callers that dispatch several independent tool calls in
// one assistant turn.
async function executeToolBlocks(
  toolUseBlocks: any[],
  loopCtx: ToolContext,
  runLog: typeof log,
  onToolCall: LoopOptions['onToolCall'],
  onToolResult: LoopOptions['onToolResult'],
  tally: (name: string, isError: boolean) => void,
): Promise<{ toolResults: unknown[]; toolCalls: number; toolErrors: number }> {
  let toolCalls = 0
  let toolErrors = 0
  const toolResults = await Promise.all(
    toolUseBlocks.map(async (block) => {
      toolCalls++
      const { toolResult, isError } = await executeToolBlock(
        block,
        loopCtx,
        runLog,
        onToolCall,
        onToolResult,
      )
      if (isError) toolErrors++
      tally(block.name, isError)
      return toolResult
    }),
  )
  return { toolResults, toolCalls, toolErrors }
}

// Mensajes que entraron desde afuera mientras el run corría. Se drenan ACÁ
// —antes del fetch, después del chequeo de abort— porque es el único punto
// del turno donde agregar contenido no rompe nada: a mitad de un `tool_use`
// pendiente, un mensaje de usuario intercalado invalida el siguiente
// request. Se marcan entregados DESPUÉS de incorporarlos: un run que muere
// entre el drenaje y el turno tiene que poder volver a leerlos.
async function drainInjectedMessages(
  drainMessages: LoopOptions['drainMessages'],
  onMessagesDelivered: LoopOptions['onMessagesDelivered'],
  messages: ApiMessage[],
  runLog: typeof log,
): Promise<void> {
  if (!drainMessages) return
  try {
    const injected = await drainMessages()
    if (!injected.length) return
    messages.push({
      role: 'user',
      content: injected.map((m) => (m.author ? `[${m.author}] ${m.body}` : m.body)).join('\n\n'),
    })
    runLog.info({ count: injected.length }, 'Mensajes inyectados en el run')
    await onMessagesDelivered?.(injected.map((m) => m.id))
  } catch (err) {
    // Un fallo del store no puede voltear el run: el agente sigue con lo que
    // tenía, y el mensaje se vuelve a intentar el turno que viene.
    runLog.warn({ err }, 'No se pudieron drenar los mensajes inyectados')
  }
}

// Compacta la historia cuando excede el presupuesto de caracteres. El
// checkpoint se guarda DESPUÉS de compactar y justo antes del request, así
// que lo persistido es exactamente la conversación que se mandó — guardarlo
// antes dejaría en disco una historia que este mismo run ya descartó.
//
// Devuelve el JSON ya serializado de `messages` (post-compactación si
// corrió) para que el llamador lo reuse tanto en el chequeo de presupuesto
// como en la decisión de si toca guardar el checkpoint de esta vuelta — un
// solo `JSON.stringify` del array completo por vuelta, no dos.
async function compactIfOverBudget(messages: ApiMessage[], runLog: typeof log): Promise<string> {
  let json = JSON.stringify(messages)
  if (json.length <= COMPACTION_BUDGET_CHARS) return json
  const compacted = await compactHistory(messages, runLog)
  if (compacted !== messages) {
    messages.splice(0, messages.length, ...compacted)
    json = JSON.stringify(messages)
  }
  return json
}

// Cada cuántas vueltas se persiste el checkpoint como tope, aun si la
// historia casi no creció — pone un piso a cuánto puede atrasarse el
// checkpoint respecto del request real.
const CHECKPOINT_EVERY_ITERS = 5

// O antes, si la historia creció esto en bytes desde el último guardado — una
// vuelta con un tool_result grande no debería esperar `CHECKPOINT_EVERY_ITERS`
// para persistirse.
const CHECKPOINT_MIN_GROWTH_BYTES = 50_000

// Decide si ESTA vuelta debe escribir el checkpoint, en vez de hacerlo en
// cada una.
//
// INVARIANTE que se sacrifica: antes, el checkpoint en disco era siempre la
// conversación exacta que se mandó al último request — espaciar los
// guardados puede dejarlo hasta `CHECKPOINT_EVERY_ITERS - 1` vueltas atrás.
// Es aceptable porque el checkpoint de CUALQUIER vuelta anterior sigue siendo
// un punto de reanudación válido: los pares `tool_use`/`tool_result` se
// completan dentro de la misma vuelta antes de agregar el turno, así que
// nunca queda un `tool_use` colgado en el array persistido. El único costo es
// repetir en la API las últimas vueltas no checkpointeadas al reanudar — nunca
// un request inválido.
//
// Por qué esto pasa de cuadrático a mucho más barato: hoy la escritura pisa
// la fila entera en SQLite (ver migración 066), así que su costo de I/O crece
// con el tamaño de la historia — y en un run de N vueltas donde la historia
// crece con cada una, escribir en TODAS las vueltas es O(N²) total. Escribir
// cada `CHECKPOINT_EVERY_ITERS` vueltas divide esa cuenta por esa constante
// sin cambiar la corrección del resume.
function shouldCheckpoint(
  iters: number,
  lastCheckpointIters: number,
  historyBytes: number,
  lastCheckpointBytes: number,
): boolean {
  return (
    iters - lastCheckpointIters >= CHECKPOINT_EVERY_ITERS ||
    historyBytes - lastCheckpointBytes >= CHECKPOINT_MIN_GROWTH_BYTES
  )
}

// Un fallo del store no puede voltear el run — perder el checkpoint degrada
// la recuperación, tirar acá tiraría el trabajo que el checkpoint existe
// para salvar.
async function saveLoopCheckpoint(
  saveCheckpoint: LoopOptions['saveCheckpoint'],
  messages: ApiMessage[],
  runLog: typeof log,
  iters: number,
): Promise<void> {
  if (!saveCheckpoint) return
  try {
    await saveCheckpoint({ messages: [...messages] })
  } catch (err) {
    runLog.warn({ err, iters }, 'No se pudo guardar el checkpoint del run')
  }
}

// Server-tool calls (`mcp_tool_use`, `tool_search_tool_regex`, ...) are
// resolved server-side by Anthropic within the same response, normally
// arriving paired with their own result block — with one DOCUMENTED
// exception: per Anthropic's docs
// (server-tools#mixing-server-tools-and-client-tools-in-one-turn), when
// Claude calls one of these in the SAME parallel batch as a client
// `tool_use`, the API returns immediately with `stop_reason: "tool_use"`
// and leaves the server-tool call unpaired — it runs the deferred call on
// the NEXT request, once we send back the client tool_result blocks. That's
// the normal tool_use path (filtered to `type === 'tool_use'`, so the
// dangling server-tool call is left alone and Anthropic resolves it against
// the still-open turn). Ending the run on every occurrence — as this code
// used to — turned a routine, self-resolving response shape into a
// permanent stall on any task whose agent checks GitHub state via MCP while
// also reading/running something locally.
//
// Genuinely unrecoverable cases stay unrecoverable: `max_tokens` cutting a
// server-tool call's input off mid-stream (retried same as a client
// tool_use), and a dangling server-tool call with NO accompanying client
// `tool_use` — that shape isn't documented as self-resolving and blindly
// persisting/resending it 400s the next request with "<type> ... found
// without a corresponding <type>_result block" (see subscriptions#1411 for
// `mcp_tool_use`, subscriptions#1466 for `tool_search_tool_regex` — same
// failure mode, different server-tool type).
// Cierra la llamada de server-tool que quedó a medias cuando pausó el turno.
//
// Una pausa de CUALQUIERA de estos server-tools deja SU PROPIA llamada sin
// result: es la forma normal de un `pause_turn`, no una anomalía. Los tres
// caminos obvios estaban todos mal:
//
//   - reenviar el turno tal cual → 400 "<type> ... found without a
//     corresponding <type>_result block" (bb6b36ad8 / subscriptions#1411,
//     y de nuevo con `tool_search_tool_regex` en subscriptions#1466 — el
//     tipo de bloque cambia, el 400 es el mismo);
//   - descartar el turno y repetir el request → el request es byte-idéntico,
//     así que el conector RE-EJECUTA las llamadas del turno que ya habían
//     corrido: con un MCP no idempotente (`add_issue_comment`, `create_issue`)
//     son comentarios e issues duplicados, uno por reintento;
//   - terminar el run → es lo que hacía, y es lo que dejaba
//     `maxPauseTurnRetries` como config muerta para todo agente con MCP
//     remoto (run 08f148b7: el refiner tenía 5 reintentos y murió en iters=2).
//
// Parear el bloque con un result sintético de error es el único que no miente:
// la historia queda válida (el result de server-tool en un turno assistant es
// la forma que la API ya emite y que este loop reenvía en cada vuelta normal),
// no se re-ejecuta nada, y el modelo ve que ESA llamada quedó sin respuesta y
// decide si la repite. El texto que alcanzó a escribir se conserva.
//
// El mapa cubre sólo los tipos de server-tool que este engine puede llegar a
// declarar (ver `packages/ai-providers/src/anthropic-api/provider.ts`): el
// conector MCP y las dos variantes de tool search (regex y bm25 — hoy sólo se
// usa regex, bm25 se agrega preventivamente porque comparte el mismo riesgo
// si algún agente la habilita). Una key que no aparece en NINGUNO de los dos
// mapas de abajo NO se aparea — cae al camino viejo
// (`handleUnresolvedServerToolUse`, que corta el run en vez de adivinar un
// `type` de result que podría no existir y producir un 400 distinto).
//
// Hay DOS mapas, no uno, porque hay dos hipótesis sobre cómo llega el bloque
// de la llamada — y cada una implica un result distinto, no intercambiable:
//
//   - `DIRECT_TYPE_RESULT`: el bloque trae su propio `type` dedicado
//     (`mcp_tool_use` siempre lo hace; `tool_search_tool_regex` según el
//     texto LITERAL del 400 real de subscriptions#1466 — "`tool_search_tool_regex`
//     tool use ... found without a corresponding `tool_search_tool_regex_tool_result`
//     block"). El result que se sintetiza en esta forma sale de esa misma
//     fuente: el sufijo por variante.
//   - `WRAPPED_NAME_RESULT`: el bloque viene envuelto como
//     `{type: 'server_tool_use', name: '<tool>'}` — la forma que declara
//     `ServerToolUseBlock` en el `@anthropic-ai/sdk` instalado (transitivo,
//     NO lo usa este provider: el body sale de un `fetch` a mano en
//     provider.ts). Esa misma fuente declara el result como el genérico
//     `tool_search_tool_result`, SIN sufijo por variante — parear esta forma
//     con el sufijo de arriba contradeciría la premisa que la hace existir y
//     produciría el mismo 400 que este fix busca evitar.
//
// Las dos fuentes (el 400 real vs. el tipo del SDK) no coinciden en cuál de
// las dos formas usa Anthropic para tool search, así que se detectan LAS DOS
// en la llamada — pero cada una se aparea con SU PROPIO result, nunca el de
// la otra. Si al probar contra `subscriptions` una de las dos formas resulta
// no ocurrir nunca, ese mapa se puede achicar sin tocar el otro.
// `kind` decide el SHAPE del result sintético, no sólo su `type` — los dos
// no comparten schema. `mcp_tool_result` lleva `is_error` + `content` como
// array de bloques de texto (la forma que Anthropic ya documenta para MCP).
// `ToolSearchToolResultBlockParam` (`@anthropic-ai/sdk`) es distinto: SIN
// `is_error`, y `content` es un objeto ÚNICO — para un fallo,
// `{type: 'tool_search_tool_result_error', error_code, error_message}`
// (`ToolSearchToolResultErrorParam`). Sintetizar con el shape de MCP para un
// result de tool search 400earía por forma inválida — el mismo síntoma que
// este fix busca evitar, sólo que por un motivo distinto.
type ServerToolResultKind = 'mcp' | 'tool_search'
type ServerToolResult = { type: string; kind: ServerToolResultKind }

const DIRECT_TYPE_RESULT: Record<string, ServerToolResult> = {
  mcp_tool_use: { type: 'mcp_tool_result', kind: 'mcp' },
  tool_search_tool_regex: { type: 'tool_search_tool_regex_tool_result', kind: 'tool_search' },
  tool_search_tool_bm25: { type: 'tool_search_tool_bm25_tool_result', kind: 'tool_search' },
}
const WRAPPED_NAME_RESULT: Record<string, ServerToolResult> = {
  tool_search_tool_regex: { type: 'tool_search_tool_result', kind: 'tool_search' },
  tool_search_tool_bm25: { type: 'tool_search_tool_result', kind: 'tool_search' },
}
// Todo `type` de result que cualquiera de las dos formas puede producir —
// usado sólo para reconocer una llamada YA resuelta (nunca para sintetizar).
// Tiene que cubrir las dos formas: una llamada de tool search resuelta
// normalmente puede llegar con el sufijo del 400 o con el genérico del SDK,
// y confundir un result real con uno "sin parear" apagaría un run sano — el
// mismo turno terminado en `end_turn` con una búsqueda ya resuelta adentro
// pasaría por `handleUnresolvedServerToolUse` y cortaría un run que en
// realidad ya había terminado bien.
const KNOWN_SERVER_TOOL_RESULT_TYPES = new Set([
  ...Object.values(DIRECT_TYPE_RESULT).map((r) => r.type),
  ...Object.values(WRAPPED_NAME_RESULT).map((r) => r.type),
])

/** Result a sintetizar para este bloque de llamada (`type` + `kind` que
 *  decide su shape), según CUÁL de las dos formas trae — o `undefined` si no
 *  es ninguno de los server-tools que este engine puede declarar. */
function danglingServerToolResult(b: any): ServerToolResult | undefined {
  if (typeof b?.type !== 'string') return undefined
  if (Object.hasOwn(DIRECT_TYPE_RESULT, b.type)) return DIRECT_TYPE_RESULT[b.type]
  if (
    b.type === 'server_tool_use' &&
    typeof b.name === 'string' &&
    Object.hasOwn(WRAPPED_NAME_RESULT, b.name)
  ) {
    return WRAPPED_NAME_RESULT[b.name]
  }
  return undefined
}

const PAUSED_CALL_MESSAGE =
  'The server-tool loop paused before this call returned. Its result is unknown — call it again if you still need it.'

function buildSyntheticServerToolResult(toolUseId: string, result: ServerToolResult): unknown {
  if (result.kind === 'mcp') {
    return {
      type: result.type,
      tool_use_id: toolUseId,
      is_error: true,
      content: [{ type: 'text', text: PAUSED_CALL_MESSAGE }],
    }
  }
  return {
    type: result.type,
    tool_use_id: toolUseId,
    content: {
      type: 'tool_search_tool_result_error',
      error_code: 'unavailable',
      error_message: PAUSED_CALL_MESSAGE,
    },
  }
}

function pairDanglingServerToolUses(
  contentBlocks: any[],
  isUnresolvedServerToolUse: (block: any) => boolean,
): any[] {
  const synthetic = contentBlocks
    .filter(isUnresolvedServerToolUse)
    .map((b) =>
      buildSyntheticServerToolResult(b.id, danglingServerToolResult(b) as ServerToolResult),
    )
  return [...contentBlocks, ...synthetic]
}

function computeDanglingServerToolFlags(
  contentBlocks: any[],
  stopReason: string,
  hasPendingToolUse: boolean,
): {
  hasUnresolvedServerToolUse: boolean
  serverToolUseWillResume: boolean
  isUnresolvedServerToolUse: (block: any) => boolean
} {
  const resolvedIds = new Set(
    contentBlocks
      .filter((b) => KNOWN_SERVER_TOOL_RESULT_TYPES.has(b?.type))
      .map((b) => b.tool_use_id),
  )
  const isUnresolvedServerToolUse = (b: any) =>
    danglingServerToolResult(b) !== undefined && !resolvedIds.has(b.id)
  const hasUnresolvedServerToolUse = contentBlocks.some(isUnresolvedServerToolUse)
  const serverToolUseWillResume =
    hasUnresolvedServerToolUse && stopReason === 'tool_use' && hasPendingToolUse
  return { hasUnresolvedServerToolUse, serverToolUseWillResume, isUnresolvedServerToolUse }
}

type StopReasonAction =
  | { action: 'return'; result: LoopResult }
  | { action: 'continue'; nextFetchOverrides?: FetchApiOverrides }
  | { action: 'run_tools' }

/** Dispatcher deliberadamente plano (sin ifs anidados): cada `stopReason`
 *  resuelve a lo sumo delegando a su handler dedicado, así el costo de
 *  cognitive complexity de las 6 ramas no recae sobre `executeLoop`. */
function resolveStopReasonAction(
  stepCtx: LoopStepContext,
  state: LoopState,
  hasPendingToolUse: boolean,
  hasUnresolvedServerToolUse: boolean,
  serverToolUseWillResume: boolean,
): StopReasonAction {
  const { stopReason } = stepCtx

  if (hasUnresolvedServerToolUse && !serverToolUseWillResume) {
    return handleUnresolvedServerToolUse(stepCtx, state)
  }
  if (stopReason === 'end_turn') {
    return {
      action: 'return',
      result: {
        text: state.pausedText + stepCtx.textOf(),
        iters: stepCtx.iters,
        stopReason,
        truncated: false,
        ...stepCtx.metrics(),
      },
    }
  }
  if (stopReason === 'pause_turn' && !hasPendingToolUse) {
    return handlePauseTurn(stepCtx, state)
  }
  // `refusal`: Claude declined to respond (HTTP 200, not an error — safety
  // policy, not a budget/iteration limit). Named explicitly, rather than
  // falling into the generic "unknown stop reason" branch below, so a
  // refusal is distinguishable in logs/observability from a recoverable
  // pause — resending the same request is unlikely to help; Anthropic's
  // docs suggest a fallback model, which is a caller-level decision this
  // engine doesn't make on its own.
  if (stopReason === 'refusal') {
    stepCtx.runLog.warn({ stopReason }, 'Claude refused to respond (stop_reason=refusal)')
    return { action: 'return', result: truncatedResult(stepCtx, state) }
  }
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
    return handleMaxTokens(stepCtx, state)
  }
  if (stopReason !== 'tool_use' && !(stopReason === 'pause_turn' && hasPendingToolUse)) {
    // Unknown stop reason — surface it but flag as truncated so the caller
    // doesn't finalize the task on partial output.
    return { action: 'return', result: truncatedResult(stepCtx, state) }
  }
  return { action: 'run_tools' }
}

export async function executeLoop(
  fetchApi: (messages: ApiMessage[], overrides?: FetchApiOverrides) => Promise<any>,
  initialMessages: ApiMessage[],
  ctx: ToolContext,
  opts: LoopOptions = {},
): Promise<LoopResult> {
  const {
    onToolCall,
    onToolResult,
    signal,
    logContext,
    maxPauseTurnRetries = DEFAULT_MAX_PAUSE_TURN_RETRIES,
    retryTruncatedToolUse = false,
    drainMessages,
    onMessagesDelivered,
    saveCheckpoint,
  } = opts
  const runLog = logContext ? log.child(logContext) : log
  const messages = [...initialMessages]
  let iters = 0
  // Run-level telemetry. Accumulated here rather than reconstructed by the
  // caller because only this loop sees every individual API response and
  // every tool result — by the time a LoopResult surfaces, the per-iteration
  // `usage` blocks are gone.
  const usage: LoopUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
  let toolCalls = 0
  let toolErrors = 0
  // Por tool, además del total: es lo que distingue "explora a ciegas"
  // (muchos fs_read) de "le falta un permiso" (errores de bash_run).
  const toolBreakdown: Record<string, { calls: number; errors: number }> = {}
  const tally = (name: string, isError: boolean): void => {
    const entry = toolBreakdown[name] ?? { calls: 0, errors: 0 }
    entry.calls++
    if (isError) entry.errors++
    toolBreakdown[name] = entry
  }
  const metrics = () => ({ usage, toolCalls, toolErrors, toolBreakdown })
  // Bundled so the per-stopReason handlers above can read/mutate it by
  // reference instead of each taking three separate loose params.
  // `pausedText`: text already generated in paused turns before a
  // pause_turn retry — `textOf()` only ever reads the CURRENT response's
  // blocks, so without this, resuming after a pause and finishing on a
  // later iteration would return only the text generated after the resume,
  // silently dropping whatever Claude wrote before pausing.
  const state: LoopState = { pauseTurnRetries: 0, toolUseRetried: false, pausedText: '' }
  // Set right before a `continue` that needs the NEXT fetchApi call to
  // behave differently (currently only the max_tokens/tool_use retry
  // below, which needs one call with a higher max_tokens). Cleared every
  // iteration so it never leaks past the call it was meant for.
  let nextFetchOverrides: FetchApiOverrides | undefined
  // Canal de control del loop. Se construye acá —por run, no por dispatch—
  // porque es estado de ESTA vuelta: una tool lo usa para pedir que el turno
  // corte, y el loop lo lee al tope de la vuelta siguiente.
  let pauseReason: string | undefined
  let pauseRequested = false
  // Vuelta y tamaño de historia (bytes) del último checkpoint efectivamente
  // guardado — lo que `shouldCheckpoint` necesita para decidir la vuelta que
  // viene. Arrancan en 0 así la primera vuelta cuenta como "recién arrancó".
  let lastCheckpointIters = 0
  let lastCheckpointBytes = 0
  const loopCtx: ToolContext = {
    ...ctx,
    control: {
      requestPause: (reason) => {
        pauseRequested = true
        pauseReason = reason
      },
    },
  }

  while (iters < HARD_ITER_CAP) {
    if (signal?.aborted) {
      throw new DOMException('Agent run aborted', 'AbortError')
    }
    iters++

    await drainInjectedMessages(drainMessages, onMessagesDelivered, messages, runLog)

    // El corte se lee ACÁ y no donde se pidió: la vuelta anterior ya agregó
    // el `tool_result` de la llamada que lo pidió, así que la historia queda
    // completa. Cortar en el medio dejaría un `tool_use` sin respuesta, y el
    // próximo request con esa historia falla.
    if (pauseRequested) {
      runLog.info({ iters, reason: pauseReason }, 'Run pausado por pedido de una tool')
      return {
        text: state.pausedText,
        iters,
        stopReason: 'paused',
        truncated: false,
        checkpoint: { messages: [...messages], reason: pauseReason },
        ...metrics(),
      }
    }

    const historyJson = await compactIfOverBudget(messages, runLog)
    if (shouldCheckpoint(iters, lastCheckpointIters, historyJson.length, lastCheckpointBytes)) {
      await saveLoopCheckpoint(saveCheckpoint, messages, runLog, iters)
      lastCheckpointIters = iters
      lastCheckpointBytes = historyJson.length
    }

    const response = await fetchApi(messages, nextFetchOverrides)
    nextFetchOverrides = undefined
    accumulateUsage(usage, response?.usage)
    const stopReason: string = response.stop_reason

    // Collect text and tool_use blocks from response
    const contentBlocks: any[] = response.content ?? []
    messages.push({ role: 'assistant', content: contentBlocks })
    // Anthropic's docs say a client `tool_use` block never shares a
    // response with `pause_turn` (pausing is server-tool-only; a pending
    // client tool call always surfaces as `stop_reason: tool_use`) — but
    // that's an API-side guarantee, not something this loop can verify.
    // Check anyway: if it ever doesn't hold, blindly resending an assistant
    // turn with an unresolved `tool_use` 400s the next request outright
    // ("tool_use ids were found without tool_result blocks"). Cheap
    // insurance — falls through to the normal tool-execution path below
    // instead of the pause_turn retry when this is non-empty.
    const hasPendingToolUse = contentBlocks.some((b) => b?.type === 'tool_use')

    const textOf = () =>
      contentBlocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('')

    const { hasUnresolvedServerToolUse, serverToolUseWillResume, isUnresolvedServerToolUse } =
      computeDanglingServerToolFlags(contentBlocks, stopReason, hasPendingToolUse)
    const pausedWithDanglingServerTool = stopReason === 'pause_turn' && hasUnresolvedServerToolUse
    if (pausedWithDanglingServerTool) {
      messages[messages.length - 1] = {
        role: 'assistant',
        content: pairDanglingServerToolUses(contentBlocks, isUnresolvedServerToolUse),
      }
    }
    const stepCtx: LoopStepContext = {
      response,
      contentBlocks,
      stopReason,
      iters,
      metrics,
      textOf,
      messages,
      runLog,
      retryTruncatedToolUse,
      maxPauseTurnRetries,
    }

    const action = resolveStopReasonAction(
      stepCtx,
      state,
      hasPendingToolUse,
      hasUnresolvedServerToolUse && !pausedWithDanglingServerTool,
      serverToolUseWillResume,
    )
    if (action.action === 'return') return action.result
    if (action.action === 'continue') {
      nextFetchOverrides = action.nextFetchOverrides
      continue
    }

    // action.action === 'run_tools' — execute all tool_use blocks in parallel
    const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use')
    const toolBlocksResult = await executeToolBlocks(
      toolUseBlocks,
      loopCtx,
      runLog,
      onToolCall,
      onToolResult,
      tally,
    )
    toolCalls += toolBlocksResult.toolCalls
    toolErrors += toolBlocksResult.toolErrors

    messages.push({ role: 'user', content: toolBlocksResult.toolResults })
  }

  // Safety net only — should never trip on a well-configured run since the
  // real limit is `task_budget` server-side.
  return {
    ...metrics(),
    text: '',
    iters,
    stopReason: 'hard_iter_cap',
    truncated: true,
  }
}
