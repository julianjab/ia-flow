import type { ProviderKind } from './IAgentProvider.js'

/**
 * Runtime context for a tool execution. Source-specific fields live under
 * `sourceContext` and are opaque here — adapter-owned tools cast to their
 * known shape.
 */
export interface ToolContext {
  repoPaths: Record<string, string>
  /** Source-provided context (set from ITransitionManager.getSourceToolContext). */
  sourceContext?: unknown
  /**
   * Absolute filesystem paths that write/edit/exec tools are allowed to touch.
   * Populated by the anthropic-api provider from `ProviderInput.writePaths`,
   * which in turn is fed by the WorkspaceManager. `undefined` means the tool
   * has no writable zones (read-only run); an empty array is equivalent.
   */
  writePaths?: string[]
}

export interface ITool<TInput = unknown> {
  readonly name: string
  readonly description: string
  readonly input_schema: object
  execute(input: TInput, ctx: ToolContext): Promise<string>
  /**
   * Which provider kinds may see this tool. Defaults to both (`['sync','async']`).
   * Tools that require the sandboxed `ToolContext.writePaths` scope (write,
   * edit, exec) should restrict to `['sync']` — the async terminal providers
   * don't build that scope.
   */
  providerKinds?: ProviderKind[]
  /**
   * When true, the tool is part of the runtime contract every task-scoped
   * agent gets for free (lifecycle: complete_task / fail_task). Internal tools
   * are always exposed regardless of the agent's `tools` allow-list. They can
   * still be hidden via `disabledTools` (per-agent opt-out) — that stays as
   * an escape hatch, but agents shouldn't need to declare them.
   */
  internal?: boolean
}
