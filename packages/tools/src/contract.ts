import type { ProviderKind } from '@ia-flow/ai-providers'
import type { ToolCategory } from '@ia-flow/shared'

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
   * Compiled permission policy for the current dispatch. Built once by the
   * AgentOrchestrator via `compilePolicy(agent.permissions | preset)` and
   * threaded end-to-end. Consumed by `bash_run` to source its bin whitelist
   * and git write scope; tools that don't care ignore it. `undefined` means
   * "legacy path" — `bash_run` falls back to a default policy that mirrors
   * the pre-issue-58 hard-coded whitelist + `assertGitSafe` rules.
   */
  policy?: CompiledPolicy
}

export interface Tool<TInput = unknown> {
  name: string
  description: string
  input_schema: object // JSON Schema for the input
  execute(input: TInput, ctx: ToolContext): Promise<string>
  /**
   * Which permission category owns this tool. Drives `getToolsByCategory`
   * and the `/api/tools/categories` UI tree. Optional so external / adapter-
   * owned tools that don't fit the built-in taxonomy can register without
   * one (they end up in the "custom" bucket).
   */
  category?: ToolCategory
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
   * agent gets for free (lifecycle: complete_task / fail_task). Internal tools
   * are always exposed, regardless of the agent's `tools` allow-list. They
   * can still be hidden via `disabledTools` (per-agent opt-out) — that stays
   * as an escape hatch, but agents shouldn't need to declare them.
   */
  internal?: boolean
  /**
   * Documentation-only marker: this tool is intended to run under providers
   * that build the sandbox it relies on (`ToolContext.writePaths` for write/
   * edit, worktree + command whitelist for run_command / workspace_reset).
   * Not consumed by `getToolDefinitions` or `buildToolInstructions` — the
   * actual exclusion for async terminal providers is done via
   * `providerKinds: ['sync']`. This flag makes the intent explicit at the
   * registration site so a reader spots it without inferring from the
   * providerKinds filter.
   */
  apiOnly?: boolean
}

export interface ToolDefinitionsOptions {
  disabledTools?: string[]
  providerKind?: ProviderKind
  toolNames?: string[]
}

export interface LoopOptions {
  onToolCall?: (name: string, input: unknown, toolUseId: string) => void
  onToolResult?: (name: string, result: string, toolUseId: string) => void
  signal?: AbortSignal
  logContext?: Record<string, unknown>
}

export interface LoopResult {
  text: string
  iters: number
  stopReason: string
  truncated: boolean
}

// ─── Policy ─────────────────────────────────────────────────────────────────
// Moved here (not application-level) so the tool engine and the policy
// compiler can share this type without a cross-package cycle — `bash_run`
// (exec/) reads `.bash`, the anthropic-api provider (via ToolExecutionPort)
// reads `.toolNames`, and `compilePolicy` (policy.ts, same package) builds it.

export interface CompiledPolicy {
  /** Canonical tool ids the agent is allowed to invoke. Aliases already
   *  resolved. Does NOT include internal lifecycle tools — the tools
   *  registry adds those regardless. */
  toolNames: Set<string>
  /** Bash sandbox scope. `bins` is the runtime whitelist for `bash_run`
   *  (empty ⇒ `bash_run` refuses everything). `git` mirrors the historic
   *  `assertGitSafe` rules but as data, not conditionals. */
  bash: {
    bins: Set<string>
    git: {
      allowReadonly: boolean
      allowPushTask: boolean
      allowPushMain: boolean
      allowBranchOps: boolean
      allowResetHard: boolean
      allowWorktreeRemove: boolean
    }
  }
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
