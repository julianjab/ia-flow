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
}
