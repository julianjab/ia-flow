// Tool registry + agentic execution loop
// Add new tools by implementing Tool<TInput> and calling registerTool()
import type { ProviderKind } from '../domain/ports/IAgentProvider.js'
import { createLogger } from '../logger.js'

const log = createLogger('tool-loop')

const ALL_KINDS: ProviderKind[] = ['sync', 'async']

export interface ToolContext {
  repoPaths: Record<string, string> // repo name → absolute path
  /**
   * Source-specific tool context, opaque to the generic tools. Adapter-owned
   * tools (e.g. tools that talk to the GitHub Projects API) cast this to
   * their known shape.
   */
  sourceContext?: unknown
  /**
   * Per-agent override for the Haiku file simplifier in read_file. `undefined`
   * means "no override"; fs.ts falls back to the global providerConfig setting.
   */
  fileSimplifierEnabled?: boolean
  /**
   * Absolute filesystem paths that write/edit/exec tools are allowed to touch.
   * Populated by the anthropic-api provider from `ProviderInput.writePaths`
   * (fed by the WorkspaceManager). `undefined` or empty → no writable zones,
   * i.e. write tools must refuse. Read tools ignore this field.
   */
  writePaths?: string[]
}

export interface Tool<TInput = unknown> {
  name: string
  description: string
  input_schema: object // JSON Schema for the input
  execute(input: TInput, ctx: ToolContext): Promise<string>
  /**
   * Which provider kinds may see this tool. Defaults to `['sync','async']`.
   * Write/edit/exec tools that require the sandboxed `ToolContext.writePaths`
   * scope should restrict to `['sync']` — async terminal providers don't
   * build that scope.
   */
  providerKinds?: ProviderKind[]
  /**
   * When true, the tool is part of the runtime contract every task-scoped
   * agent gets for free (lifecycle: complete_task / fail_task). Internal tools
   * are always exposed, regardless of the agent's `tools` allow-list. They
   * can still be hidden via `disabledTools` (per-agent opt-out) — that stays
   * as an escape hatch, but agents shouldn't need to declare them.
   */
  internal?: boolean
  /**
   * Documentation-only marker: this tool is intended to be exercised from
   * API-driven providers (e.g. anthropic-api) that build the sandbox it
   * relies on (`ToolContext.writePaths` for write/edit, a command sandbox
   * for run_command). Not read by `getToolDefinitions` or
   * `buildToolInstructions` — the actual exclusion for async terminal
   * providers is handled by `providerKinds: ['sync']`. This flag makes
   * the intent explicit at the registration site.
   */
  apiOnly?: boolean
}

const registry = new Map<string, Tool>()

function toolAppliesTo(t: Tool, kind: ProviderKind): boolean {
  return (t.providerKinds ?? ALL_KINDS).includes(kind)
}

export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool)
}

/**
 * Options accepted by `getToolDefinitions` to shape the visible tool set:
 *   - `disabledTools`: per-agent opt-out. Names in this list are removed
 *     regardless of the caller's `input.tools` filter.
 *   - `providerKind`: only tools whose `providerKinds` include this kind
 *     are returned. Async terminal providers pass `'async'` so write/edit/
 *     exec tools (declared `providerKinds: ['sync']`) never leak into the
 *     curl appendix.
 *   - `toolNames`: the agent's declared allow-list. Internal tools are
 *     included regardless.
 */
export interface ToolDefinitionsOptions {
  disabledTools?: string[]
  providerKind?: ProviderKind
  toolNames?: string[]
}

export function getToolDefinitions(opts?: ToolDefinitionsOptions): Array<{
  name: string
  description: string
  input_schema: object
}> {
  return resolveTools(opts).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))
}

/** Filter helper shared by both sync (API tool defs) and async (curl
 *  appendix) resolution paths. Returns the full `Tool` objects so callers
 *  that need `execute`, `internal`, etc. don't lose those fields. */
export function resolveTools(opts?: ToolDefinitionsOptions): Tool[] {
  const disabled = opts?.disabledTools?.length ? new Set(opts.disabledTools) : null
  const allowed = opts?.toolNames?.length ? new Set(opts.toolNames) : null
  const kind = opts?.providerKind
  return [...registry.values()].filter((t) => {
    if (disabled?.has(t.name)) return false
    if (kind && !toolAppliesTo(t, kind)) return false
    if (t.internal) return true
    if (!allowed) return true
    return allowed.has(t.name)
  })
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name)
}

/**
 * Generates the curl appendix async providers append to the prompt so a
 * terminal Claude session can invoke each tool via HTTP. Returns `''` for
 * sync providers — they expose tools natively via the API. Provider identity
 * (`kind`) drives the filter; `provider.id` is only used for logging.
 */
export function buildToolInstructions(
  toolNames: string[] | undefined,
  provider: { id: string; kind: ProviderKind },
  daemonUrl: string,
  taskId: string,
  opts?: { disabledTools?: string[] },
): string {
  if (provider.kind !== 'async') return ''

  const candidates = resolveTools({
    disabledTools: opts?.disabledTools,
    providerKind: 'async',
    toolNames,
  })
  if (!candidates.length) return ''

  const blocks = candidates.map((t) => {
    const schema = t.input_schema as {
      properties?: Record<string, { description?: string; type?: string }>
      required?: string[]
    }
    const props = schema.properties ?? {}
    const body: Record<string, string> = {}
    for (const [key, def] of Object.entries(props)) {
      if (key === 'task_id') {
        body[key] = taskId
      } else if (def.description) {
        body[key] = `<${def.description.split('.')[0]}>`
      } else {
        body[key] = `<${key}>`
      }
    }
    const bodyStr = JSON.stringify(body)
    // Async providers all share the daemon convention `POST /api/tools/<name>`.
    // Since the endpoint is uniform there's no per-provider spec to keep.
    return [
      `### ${t.name}`,
      t.description,
      '```bash',
      `curl -s -X POST ${daemonUrl}/api/tools/${t.name} \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '${bodyStr}'`,
      '```',
    ].join('\n')
  })

  return ['## Herramientas disponibles', '', ...blocks].join('\n')
}

// ─── Agentic loop ─────────────────────────────────────────────────────────
// Loops tool_use ↔ tool_result until the model returns end_turn. Runaway is
// bounded by `HARD_ITER_CAP` (a safety net, not a user-facing knob) and by
// the server-side `task_budget` when the caller opts in.

export interface LoopOptions {
  onToolCall?: (name: string, input: unknown, toolUseId: string) => void
  onToolResult?: (name: string, result: string, toolUseId: string) => void
  /** When aborted, the loop exits at the next iteration boundary and throws
   *  so the caller (provider) can propagate cancellation to the orchestrator. */
  signal?: AbortSignal
  /** Bindings merged into a child logger used by loop-internal logs (e.g.
   *  history compaction), so those lines carry the same correlation keys
   *  (runId, taskId, agent, …) as the caller's own logs. */
  logContext?: Record<string, unknown>
}

// Circuit breaker for a stuck model that never emits `end_turn`. Well above
// what any real task should need; the real stopping signal is task budget or
// `end_turn`.
const HARD_ITER_CAP = 500

type ApiMessage = { role: 'user' | 'assistant'; content: unknown }

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

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const HISTORY_COMPACTION_PROMPT_ID = 'historyCompaction'

async function compactHistory(
  messages: ApiMessage[],
  runLog: typeof log = log,
): Promise<ApiMessage[]> {
  const { systemPromptRepo } = await import('../composition/container.js')

  const historyBytes = JSON.stringify(messages).length
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
  const oauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  const authHeader: Record<string, string> | null = oauthToken
    ? { Authorization: `Bearer ${oauthToken}` }
    : apiKey
      ? { 'x-api-key': apiKey }
      : null

  // Fallback: truncate tool results to 500 chars each
  if (!authHeader) {
    runLog.warn({ historyBytes }, 'haiku compaction skipped: no auth — truncating tool results')
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

  const prompt = systemPromptRepo.getById(HISTORY_COMPACTION_PROMPT_ID)
  if (!prompt) {
    runLog.warn(
      { historyBytes, promptId: HISTORY_COMPACTION_PROMPT_ID },
      'haiku compaction skipped: system prompt not seeded — keeping history',
    )
    return messages
  }
  const compactionPrompt = prompt.text

  const toolResults: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as any[]) {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        toolResults.push(block.content)
      }
    }
  }

  const userContent = toolResults.join('\n\n---\n\n').slice(0, 150_000)
  runLog.info(
    {
      model: HAIKU_MODEL,
      historyBytes,
      toolResultCount: toolResults.length,
      userBytes: userContent.length,
      systemBytes: compactionPrompt.length,
    },
    'haiku compaction request',
  )

  const t0 = Date.now()
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeader,
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 4096,
        system: compactionPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    })
    const ms = Date.now() - t0
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      runLog.warn({ status: res.status, ms, err: errBody.slice(0, 500) }, 'haiku compaction failed')
      throw new Error(`Haiku ${res.status}`)
    }
    const data = (await res.json()) as any
    const summary = (data.content as any[])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
      .join('')

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
    // Preserve the last complete assistant/tool_result pair so the model sees
    // continuity (what it just tried + result) instead of restarting from
    // scratch. Without this, the model re-issues the same exploratory tool
    // calls forever because the collapsed history looks identical every turn.
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
    const compacted: ApiMessage[] = [...initial, summaryMsg, ...tail]
    const afterBytes = JSON.stringify(compacted).length
    runLog.info(
      {
        status: res.status,
        ms,
        summaryBytes: summary.length,
        beforeBytes: historyBytes,
        afterBytes,
        ratio: afterBytes / Math.max(historyBytes, 1),
        usage: data.usage,
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

export interface LoopResult {
  text: string
  iters: number
  stopReason: string
  /** True when the run was cut short by task budget or the internal safety cap.
   *  The orchestrator uses this to post a "paused, not finished" notice
   *  instead of the "error" path. */
  truncated: boolean
}

export async function executeLoop(
  fetchApi: (messages: ApiMessage[]) => Promise<any>,
  initialMessages: ApiMessage[],
  ctx: ToolContext,
  opts: LoopOptions = {},
): Promise<LoopResult> {
  const { onToolCall, onToolResult, signal, logContext } = opts
  const runLog = logContext ? log.child(logContext) : log
  const messages = [...initialMessages]
  let iters = 0

  while (iters < HARD_ITER_CAP) {
    if (signal?.aborted) {
      throw new DOMException('Agent run aborted', 'AbortError')
    }
    iters++
    const histSize = JSON.stringify(messages).length
    if (histSize > COMPACTION_BUDGET_CHARS) {
      const compacted = await compactHistory(messages, runLog)
      if (compacted !== messages) {
        messages.splice(0, messages.length, ...compacted)
      }
    }
    const response = await fetchApi(messages)
    const stopReason: string = response.stop_reason

    // Collect text and tool_use blocks from response
    const contentBlocks: any[] = response.content ?? []
    messages.push({ role: 'assistant', content: contentBlocks })

    const textOf = () =>
      contentBlocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('')

    if (stopReason === 'end_turn') {
      return { text: textOf(), iters, stopReason, truncated: false }
    }

    // Server-side task_budget cutoff (beta task-budgets-2026-03-13) surfaces
    // as `pause_turn`. Also treat `max_tokens` as truncated — the response is
    // partial and the caller should treat it as recoverable, not as success.
    if (stopReason === 'pause_turn' || stopReason === 'max_tokens') {
      return { text: textOf(), iters, stopReason, truncated: true }
    }

    if (stopReason !== 'tool_use') {
      // Unknown stop reason — surface it but flag as truncated so the caller
      // doesn't finalize the task on partial output.
      return { text: textOf(), iters, stopReason, truncated: true }
    }

    // Execute all tool_use blocks in parallel
    const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use')
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const tool = registry.get(block.name)
        onToolCall?.(block.name, block.input, block.id)

        let result: string
        if (!tool) {
          result = `Error: tool '${block.name}' not found`
        } else {
          try {
            result = await tool.execute(block.input, ctx)
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

        onToolResult?.(block.name, result, block.id)
        return { type: 'tool_result', tool_use_id: block.id, content: result }
      }),
    )

    messages.push({ role: 'user', content: toolResults })
  }

  // Safety net only — should never trip on a well-configured run since the
  // real limit is `task_budget` server-side.
  return {
    text: '',
    iters,
    stopReason: 'hard_iter_cap',
    truncated: true,
  }
}
