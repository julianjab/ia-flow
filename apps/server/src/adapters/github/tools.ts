// GitHub-only tools — create issues, link to project, sub-issues.
// Task-scoped tools (update body, comments, fields, labels) live in tools/task.ts
// and route through TransitionManager so they work for any source.

import { resolveGithubRepo } from '../../repos.js'
import { type ToolContext, registerTool } from '../../tools/index.js'
import { type ProjectField, addProjectItem, addSubIssue, createIssue } from './api/project.js'

/**
 * Shape of the GitHub-specific tool context, populated by
 * GitHubTransitionManager.getSourceToolContext() and surfaced on the
 * generic ToolContext as `sourceContext`.
 */
export interface GitHubToolContext {
  owner: string
  projectId: string
  fields: Record<string, ProjectField>
  itemId?: string
  issueId?: string
  repoName?: string
  issueNumber?: number
}

function requireGitHub(ctx: ToolContext): GitHubToolContext {
  const source = ctx.sourceContext as GitHubToolContext | undefined
  if (!source?.projectId)
    throw new Error('GitHub context not available — is this a GitHub-connected project?')
  return source
}

// ─── create_github_issue ──────────────────────────────────────────────────────

registerTool({
  name: 'create_github_issue',
  description:
    'Create a new GitHub issue in the given repo and add it to the project. Returns the created issue number and node ID.',
  input_schema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description:
          'Repo name (e.g. "buyer-web-front"). The owner is resolved from project context.',
      },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body in markdown' },
    },
    required: ['repo', 'title', 'body'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const gh = requireGitHub(ctx)
    const { owner, repo } = await resolveGithubRepo(input.repo, gh.owner)
    const issue = await createIssue(owner, repo, input.title, input.body)
    return JSON.stringify({
      issueId: issue.id,
      issueNumber: issue.number,
      numericId: issue.numericId,
      owner,
      repo,
    })
  },
})

// ─── add_to_project ───────────────────────────────────────────────────────────

registerTool({
  name: 'add_to_project',
  description:
    'Add an existing GitHub issue (by its node ID) to the configured project. Returns the project item ID.',
  input_schema: {
    type: 'object',
    properties: {
      issue_node_id: {
        type: 'string',
        description: 'GitHub issue node ID (from create_github_issue)',
      },
    },
    required: ['issue_node_id'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const gh = requireGitHub(ctx)
    const { itemId } = await addProjectItem(gh.projectId, input.issue_node_id)
    return JSON.stringify({ itemId })
  },
})

// ─── add_sub_issue ────────────────────────────────────────────────────────────

registerTool({
  name: 'add_sub_issue',
  description: 'Link an issue as a sub-issue (child) of a parent issue on GitHub.',
  input_schema: {
    type: 'object',
    properties: {
      parent_repo: { type: 'string', description: 'Repo name of the parent issue' },
      parent_issue_number: { type: 'number', description: 'Issue number of the parent' },
      child_numeric_id: {
        type: 'number',
        description:
          'Numeric (database) ID of the child issue (from create_github_issue → numericId)',
      },
    },
    required: ['parent_repo', 'parent_issue_number', 'child_numeric_id'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const gh = requireGitHub(ctx)
    const { owner, repo } = await resolveGithubRepo(input.parent_repo, gh.owner)
    await addSubIssue(owner, repo, input.parent_issue_number, input.child_numeric_id)
    return `Sub-issue linked: #${input.child_numeric_id} → parent #${input.parent_issue_number}`
  },
})
