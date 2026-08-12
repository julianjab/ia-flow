// Tool registry + agentic execution loop
// Add new tools by implementing Tool<TInput> and calling registerTool()
import { createLogger } from '../logger.js'

const log = createLogger('tool-loop')

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

/** HTTP execution spec for async providers (tmux/iterm). */
export interface ToolHttpSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Server route path, e.g. '/api/tools/complete_task' */
  path: string
}

export interface Tool<TInput = unknown> {
  name: string
  description: string
  input_schema: object // JSON Schema for the input
  execute(input: TInput, ctx: ToolContext): Promise<string>
  /** Per-provider execution specs for async (non-API) providers. */
  providers?: {
    'tmux-claude'?: ToolHttpSpec
    'iterm-claude'?: ToolHttpSpec
  }
  /**
   * When true, the tool is only exposed to the `anthropic-api` provider. It is
   * excluded from `buildToolInstructions` and from any
   * `getToolDefinitions({ excludeApiOnly: true })` call, so tmux/iterm terminal
   * Claude sessions can't discover or invoke it via the HTTP curl appendix.
   * Used for write/edit/exec tools that require the sandboxed
   * `ToolContext.writePaths` scope which async providers don't set up.
   */
  apiOnly?: boolean
}

const ASYNC_PROVIDERS = new Set(['tmux-claude', 'iterm-claude'])

const registry = new Map<string, Tool>()

export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool)
}

/**
 * Options accepted by `getToolDefinitions` to shape the visible tool set:
 *   - `disabledTools`: per-agent opt-out. Names in this list are removed
 *     regardless of the caller's `input.tools` filter.
 *   - `excludeApiOnly`: hide tools flagged `apiOnly: true`. Terminal providers
 *     (tmux/iterm) pass this so write/edit/exec tools never leak into the
 *     curl appendix.
 */
export interface ToolDefinitionsOptions {
  disabledTools?: string[]
  excludeApiOnly?: boolean
}

export function getToolDefinitions(opts?: ToolDefinitionsOptions): Array<{
  name: string
  description: string
  input_schema: object
}> {
  const disabled = opts?.disabledTools?.length ? new Set(opts.disabledTools) : null
  const excludeApiOnly = opts?.excludeApiOnly === true
  return [...registry.values()]
    .filter((t) => !(disabled?.has(t.name) ?? false))
    .filter((t) => !(excludeApiOnly && t.apiOnly))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name)
}

/**
 * Generates structured curl instructions for async providers (tmux/iterm).
 * Returns empty string for anthropic-api (uses native tool_use) or when no
 * tools have specs. Tools flagged `apiOnly` are always excluded — they only
 * work under the anthropic-api provider's sandboxed `ToolContext.writePaths`.
 */
export function buildToolInstructions(
  toolNames: string[] | undefined,
  providerId: string,
  daemonUrl: string,
  taskId: string,
): string {
  if (!ASYNC_PROVIDERS.has(providerId)) return ''

  const pid = providerId as 'tmux-claude' | 'iterm-claude'
  const candidates = [...registry.values()].filter((t) => {
    if (t.apiOnly) return false
    if (!t.providers?.[pid]) return false
    return toolNames?.length ? toolNames.includes(t.name) : true
  })

  if (!candidates.length) return ''

  const blocks = candidates.map((t) => {
    const spec = t.providers![pid]!
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
    return [
      `### ${t.name}`,
      t.description,
      '```bash',
      `curl -s -X ${spec.method} ${daemonUrl}${spec.path} \\`,
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
  onToolCall?: (name: string, input: unknown) => void
  onToolResult?: (name: string, result: string) => void
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

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const HISTORY_COMPACTION_PROMPT_ID = 'historyCompaction'

async function compactHistory(
  messages: ApiMessage[],
  runLog: typeof log = log,
): Promise<ApiMessage[]> {
  const { systemPromptRepo } = await import('../composition/container.js')

  const historyBytes = JSON.stringify(messages).length
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
    const compacted: ApiMessage[] = [...initial, summaryMsg]
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
    const sendMessages =
      histSize > COMPACTION_BUDGET_CHARS ? await compactHistory(messages, runLog) : messages
    const response = await fetchApi(sendMessages)
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
        onToolCall?.(block.name, block.input)

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

        onToolResult?.(block.name, result)
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
