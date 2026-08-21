// Tool registry + agentic execution loop
// Add new tools by implementing Tool<TInput> and calling registerTool()
import type { ProviderKind } from '@ia-flow/ai-providers'
import type {
  LoopOptions,
  LoopResult,
  Tool,
  ToolContext,
  ToolDefinitionsOptions,
} from './contract.js'
import { createLogger } from './logger.js'
import { getSystemPromptPort } from './ports.js'

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
    input_schema: t.input_schema,
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
    if (t.internal) return true
    if (!allowed) return true
    return allowed.has(t.name)
  })
}

export function getTool(name: string): Tool | undefined {
  const direct = registry.get(name)
  if (direct) return direct
  const canonical = aliasIndex.get(name)
  return canonical ? registry.get(canonical) : undefined
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

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const HISTORY_COMPACTION_PROMPT_ID = 'historyCompaction'

async function compactHistory(
  messages: ApiMessage[],
  runLog: typeof log = log,
): Promise<ApiMessage[]> {
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

  const systemPromptPort = getSystemPromptPort()
  if (!systemPromptPort) {
    runLog.warn(
      { historyBytes },
      'haiku compaction skipped: no SystemPromptPort wired — keeping history',
    )
    return messages
  }
  const prompt = systemPromptPort.getById(HISTORY_COMPACTION_PROMPT_ID)
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
    maxPauseTurnRetries = 0,
    retryTruncatedToolUse = false,
  } = opts
  const runLog = logContext ? log.child(logContext) : log
  const messages = [...initialMessages]
  let iters = 0
  let pauseTurnRetries = 0
  let toolUseRetried = false
  // Text already generated in paused turns before a pause_turn retry —
  // `textOf()` only ever reads the CURRENT response's blocks, so without
  // this, resuming after a pause and finishing on a later iteration would
  // return only the text generated after the resume, silently dropping
  // whatever Claude wrote before pausing. Prefixed onto every returned
  // `text` below; stays '' (no-op) when no pause_turn retry happens.
  let pausedText = ''
  // Set right before a `continue` that needs the NEXT fetchApi call to
  // behave differently (currently only the max_tokens/tool_use retry
  // below, which needs one call with a higher max_tokens). Cleared every
  // iteration so it never leaks past the call it was meant for.
  let nextFetchOverrides: FetchApiOverrides | undefined

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
    const response = await fetchApi(messages, nextFetchOverrides)
    nextFetchOverrides = undefined
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

    if (stopReason === 'end_turn') {
      return { text: pausedText + textOf(), iters, stopReason, truncated: false }
    }

    // `pause_turn`: the server-side sampling loop for server tools (remote
    // MCP connectors, web search, …) hit its own iteration cap — default 10
    // per Anthropic request, independent of `task_budget` — and paused the
    // turn to hand control back to us. Per Anthropic's docs
    // (platform.claude.com/docs/en/build-with-claude/handling-stop-reasons),
    // the correct continuation is resending the message list UNCHANGED: we
    // already pushed the paused assistant turn above, so simply looping
    // back and re-calling `fetchApi(messages)` does exactly that — no new
    // user message, no stripped history, same `tools`/`mcp_servers` (owned
    // by the caller's `fetchApi` closure, untouched here). Bounded by
    // `maxPauseTurnRetries` (opt-in per agent, default 0) so a model that
    // keeps re-triggering the server-tool cap can't loop forever.
    if (stopReason === 'pause_turn' && !hasPendingToolUse) {
      if (pauseTurnRetries < maxPauseTurnRetries) {
        pauseTurnRetries++
        pausedText += textOf()
        runLog.info(
          { stopReason, pauseTurnRetries, maxPauseTurnRetries },
          'pause_turn — resuming turn unchanged',
        )
        continue
      }
      return { text: pausedText + textOf(), iters, stopReason, truncated: true }
    }

    // `refusal`: Claude declined to respond (HTTP 200, not an error — safety
    // policy, not a budget/iteration limit). Named explicitly, rather than
    // falling into the generic "unknown stop reason" branch below, so a
    // refusal is distinguishable in logs/observability from a recoverable
    // pause — resending the same request is unlikely to help; Anthropic's
    // docs suggest a fallback model, which is a caller-level decision this
    // engine doesn't make on its own.
    if (stopReason === 'refusal') {
      runLog.warn({ stopReason }, 'Claude refused to respond (stop_reason=refusal)')
      return { text: pausedText + textOf(), iters, stopReason, truncated: true }
    }

    // `max_tokens` / `model_context_window_exceeded`: the response itself is
    // partial (cut mid-generation), not a pause between server-tool rounds —
    // resending unchanged won't recover it, so always treat as truncated...
    if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
      // ...EXCEPT the one case Anthropic's docs call out as recoverable: the
      // very last block is an in-progress `tool_use` whose JSON input got
      // cut off mid-stream. That block is unusable (can't execute a tool
      // call with truncated input), so resending with the SAME history is
      // pointless too — instead drop the corrupted assistant turn we just
      // pushed and retry the exact same request once with more max_tokens.
      // Bounded to a single retry per run (not per-occurrence) so a model
      // that keeps generating huge tool inputs can't inflate cost unbounded.
      const lastBlock = contentBlocks[contentBlocks.length - 1]
      if (
        retryTruncatedToolUse &&
        !toolUseRetried &&
        stopReason === 'max_tokens' &&
        lastBlock?.type === 'tool_use'
      ) {
        toolUseRetried = true
        messages.pop()
        nextFetchOverrides = { bumpMaxTokens: true }
        runLog.warn(
          { stopReason, tool: lastBlock.name },
          'max_tokens cut off a tool_use block — retrying once with more tokens',
        )
        continue
      }
      return { text: pausedText + textOf(), iters, stopReason, truncated: true }
    }

    if (stopReason !== 'tool_use' && !(stopReason === 'pause_turn' && hasPendingToolUse)) {
      // Unknown stop reason — surface it but flag as truncated so the caller
      // doesn't finalize the task on partial output.
      return { text: pausedText + textOf(), iters, stopReason, truncated: true }
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
