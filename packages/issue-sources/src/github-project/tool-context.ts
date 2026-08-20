import type { ProjectField } from './api/project.js'

/**
 * Shape of the GitHub-specific tool context, populated by
 * GitHubTaskSource.getSourceToolContext() and surfaced on the host's
 * generic ToolContext as `sourceContext`. Consumed by apps/server's
 * `adapters/github/tools.ts` (tool registration is a host concern — the tool
 * engine itself lives in apps/server, not in this package).
 */
export interface GitHubToolContext {
  owner: string
  /**
   * Optional: absent for sources with no Projects v2 board (github-issues).
   * Tools that genuinely need a board (`add_to_project`) must check this
   * themselves and fail with a clear message — `requireGitHub` only
   * guarantees `owner`, the one thing every GitHub-backed source has.
   */
  projectId?: string
  fields: Record<string, ProjectField>
  itemId?: string
  issueId?: string
  repoName?: string
  issueNumber?: number
}
