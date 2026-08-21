import type { ProviderKind } from '@ia-flow/ai-providers'
import type { BashRunConfig } from '@ia-flow/shared'

// ─── Tool engine types ──────────────────────────────────────────────────────

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
   * means "no override"; fs tools fall back to the global providerConfig setting.
   */
  fileSimplifierEnabled?: boolean
  /**
   * Absolute filesystem paths that write/edit/exec tools are allowed to touch.
   * Populated by the anthropic-api provider from `ProviderInput.writePaths`
   * (fed by the WorkspaceManager). `undefined` or empty → no writable zones,
   * i.e. write tools must refuse. Read tools ignore this field.
   */
  writePaths?: string[]
  /**
   * Id of the task this run is scoped to. Propagated by the anthropic-api
   * provider from `ProviderInput.taskId`. Tools that need to identify the
   * active task without asking the agent (e.g. `workspace_reset` accepting an
   * empty `{}` input) read it from here. `undefined` when a tool is invoked
   * outside a run (tests, ad-hoc HTTP endpoints).
   */
  taskId?: string
  /**
   * Compiled policy for the current dispatch. Built once by the orchestrator
   * via `compilePolicy(agent.tools)` and threaded end-to-end. Consumed by
   * `bash_run` to source its `bashRun` allow/deny command patterns; tools
   * that don't care ignore it. An agent with no `bash_run` entry in
   * `tools[]` simply has `bashRun: undefined`, and `bash_run` refuses
   * everything.
   */
  policy?: CompiledPolicy
  /**
   * Which provider kind is actually running this call ('sync' | 'async').
   * Set by the caller that builds `ctx` (anthropic-api → 'sync'; the
   * ia-flow-tools MCP route → 'async'). The execution dispatcher
   * (`engine.ts`'s `executeLoop`, and the MCP `tools/call` handler) uses it
   * to refuse a tool whose `providerKinds` doesn't include this kind — the
   * `tools:`/`tools/list` definitions sent to the model already filter on
   * this, but that only controls what's *offered*; a model can still emit a
   * `tool_use` for a name it wasn't offered (e.g. because the prompt told it
   * to), so the dispatcher has to re-check at call time too. `undefined` ⇒
   * no kind restriction is enforced (ad-hoc/test contexts).
   */
  providerKind?: ProviderKind
}

export interface Tool<TInput = unknown> {
  name: string
  description: string
  input_schema: object // JSON Schema for the input
  execute(input: TInput, ctx: ToolContext): Promise<string>
  /**
   * Legacy names this tool used to be registered as. `resolveAliases` maps
   * them back to the canonical `name` so old `AgentDefinition.tools[]`
   * entries (`run_command`, `read_file`, …) keep working after the rename.
   */
  aliases?: string[]
  /**
   * Which provider kinds may see this tool. Defaults to `['sync','async']`.
   * Write/edit/exec tools that require the sandboxed `ToolContext.writePaths`
   * scope should restrict to `['sync']` — async terminal providers don't
   * build that scope.
   */
  providerKinds?: ProviderKind[]
  /**
   * When true, the tool is part of the runtime contract every task-scoped
   * agent gets for free (lifecycle: complete_task / fail_task). Internal
   * tools are always exposed, regardless of the agent's `tools[]` list.
   */
  internal?: boolean
  /**
   * Documentation-only marker: this tool is intended to run under providers
   * that build the sandbox it relies on (`ToolContext.writePaths` for write/
   * edit, worktree + command whitelist for run_command / workspace_reset).
   * Not consumed by `getToolDefinitions` — the
   * actual exclusion for async terminal providers is done via
   * `providerKinds: ['sync']`. This flag makes the intent explicit at the
   * registration site so a reader spots it without inferring from the
   * providerKinds filter.
   */
  apiOnly?: boolean
}

export interface ToolDefinitionsOptions {
  providerKind?: ProviderKind
  toolNames?: string[]
}

export interface LoopOptions {
  onToolCall?: (name: string, input: unknown, toolUseId: string) => void
  onToolResult?: (name: string, result: string, toolUseId: string) => void
  signal?: AbortSignal
  logContext?: Record<string, unknown>
  /**
   * How many times to resend the same message history when the model pauses
   * a long turn (`stop_reason: pause_turn`) instead of treating it as
   * truncated. Anthropic emits `pause_turn` both for a genuinely exhausted
   * server-side `task_budget` and for long agentic turns with server-side
   * MCP tool round-trips that just need the client to let the turn resume —
   * in both cases the correct continuation is resending the unchanged
   * history. Defaults to 0 (today's behavior: first `pause_turn` is
   * terminal) so existing agents are unaffected until they opt in.
   */
  maxPauseTurnRetries?: number
  /**
   * When the model hits `max_tokens` with an in-progress `tool_use` block
   * as the last content block (JSON input cut off mid-stream — unusable),
   * retry once with a higher max_tokens for that single request instead of
   * returning the run as truncated. Anthropic's docs call this out as the
   * one `max_tokens` case worth retrying (the tool call itself, not the
   * whole turn). Defaults to false. Bounded to a single retry per run.
   */
  retryTruncatedToolUse?: boolean
}

export interface LoopResult {
  text: string
  iters: number
  stopReason: string
  truncated: boolean
  /**
   * The full raw Anthropic API response (`JSON.stringify`d, capped — see
   * `RAW_RESPONSE_LOG_CAP` in engine.ts) for the call that ended the loop.
   * Only set when `truncated` — a successful `end_turn` doesn't need it,
   * and capturing it there for every run would bloat every execution log
   * for no reason. Lets the caller persist *why* a run got cut short
   * (stop_reason detail, `usage`, the partial content itself) instead of
   * just the short `stopReason` string — see Agent.ts's truncated branch,
   * which stores this in `errorMsg`.
   */
  rawResponse?: string
}

// ─── Policy ─────────────────────────────────────────────────────────────────
// Moved here (not application-level) so the tool engine and the policy
// compiler can share this type without a cross-package cycle — `bash_run`
// (exec/) reads `.bashRun`, the anthropic-api provider (via ToolExecutionPort)
// reads `.toolNames`, and `compilePolicy` (policy.ts, same package) builds it.

export interface CompiledPolicy {
  /** Canonical tool ids the agent is allowed to invoke. Aliases already
   *  resolved. Does NOT include internal lifecycle tools — the tools
   *  registry adds those regardless. */
  toolNames: Set<string>
  /** Allow/deny command patterns from the agent's `bash_run` tool entry.
   *  `undefined` ⇒ the agent has no `bash_run` entry in `tools[]`, so
   *  `bash_run` refuses every command outright. */
  bashRun?: BashRunConfig
}

// ─── Injected ports ─────────────────────────────────────────────────────────
// apps/server's composition/container.ts supplies the concrete (DB-backed)
// implementations at startup via the matching `setXxxPort` in engine.ts /
// workspace/ / github/ — this package never imports apps/server.

/** Narrow view of the system-prompt store, consumed by `compactHistory` to
 *  fetch the Haiku compaction prompt. */
export interface SystemPromptPort {
  getById(id: string): { text: string } | null | undefined
}

/** Narrow view of `WorkspaceManager`, consumed by `workspace_reset`. */
export interface WorkspaceManagerPort {
  resetWorktree(taskId: string): Promise<string>
}

/** Resolves a local repo name (+ default owner) to its GitHub owner/repo,
 *  consumed by the GitHub tools. Mirrors `resolveGithubRepo` in
 *  apps/server/src/repos.ts. */
export interface RepoResolverPort {
  resolveGithubRepo(
    localName: string,
    defaultOwner: string,
  ): Promise<{ owner: string; repo: string }>
}
