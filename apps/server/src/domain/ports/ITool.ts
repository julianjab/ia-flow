export interface ToolHttpSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
}

export interface GitHubToolContext {
  owner: string
  projectId: string
  fields: Record<
    string,
    { id: string; name?: string; dataType?: string; options?: { id: string; name: string }[] }
  >
  itemId?: string
  issueId?: string
  repoName?: string
  issueNumber?: number
}

export interface ToolContext {
  repoPaths: Record<string, string>
  github?: GitHubToolContext
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
