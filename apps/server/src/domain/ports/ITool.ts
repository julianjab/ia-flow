export interface ToolHttpSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
}

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
  providers?: {
    'tmux-claude'?: ToolHttpSpec
    'iterm-claude'?: ToolHttpSpec
  }
  /**
   * When true, the tool is only exposed to the `anthropic-api` provider. It is
   * excluded from `buildToolInstructions` for tmux/iterm providers so those
   * terminal Claude sessions can't discover or invoke it via the HTTP curl
   * appendix. Used for write/edit/exec tools that require the sandboxed
   * `ToolContext.writePaths` scope which async providers don't set up.
   */
  apiOnly?: boolean
}
