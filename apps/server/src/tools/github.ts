import { getPendingTask } from '../agents/pending-tasks.js'
import { addLabelsToIssue } from '../github/labels.js'
import {
  addIssueComment,
  addProjectItem,
  addSubIssue,
  createIssue,
  setProjectTextField,
  updateItemStatus,
} from '../github/project.js'
import { resolveGithubRepo } from '../repos.js'
// GitHub tools — available to agents that have them listed in their tools[] config
import { type ToolContext, registerTool } from './index.js'

function requireGitHub(ctx: ToolContext) {
  if (!ctx.github)
    throw new Error('GitHub context not available — is this a GitHub-connected project?')
  return ctx.github
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

// ─── set_project_field ────────────────────────────────────────────────────────

registerTool({
  name: 'set_project_field',
  description:
    'Set a field value on a project item. Works for single-select fields (Status, Task Type, Priority, Size) and text fields (Repos).',
  input_schema: {
    type: 'object',
    properties: {
      field_name: {
        type: 'string',
        description:
          'Field name exactly as it appears in the project (e.g. "Status", "Task Type", "Repos")',
      },
      value: { type: 'string', description: 'Value to set' },
    },
    required: ['field_name', 'value'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const gh = requireGitHub(ctx)
    const itemId = gh.itemId
    if (!itemId) throw new Error('item_id is required')
    const field = gh.fields[input.field_name]
    if (!field) {
      const available = Object.keys(gh.fields).join(', ')
      throw new Error(`Field '${input.field_name}' not found. Available: ${available}`)
    }
    if (field.options) {
      await updateItemStatus(gh.projectId, itemId, field, input.value)
    } else {
      await setProjectTextField(gh.projectId, itemId, field, input.value)
    }
    return `Field '${input.field_name}' set to '${input.value}'`
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

// ─── add_issue_labels ─────────────────────────────────────────────────────────

registerTool({
  name: 'add_issue_labels',
  description: 'Add labels to the current GitHub issue being processed.',
  input_schema: {
    type: 'object',
    properties: {
      labels: { type: 'array', items: { type: 'string' }, description: 'Label names to add' },
    },
    required: ['labels'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const gh = requireGitHub(ctx)
    if (!gh.repoName || gh.issueNumber == null) {
      throw new Error('repoName and issueNumber are required for add_issue_labels')
    }
    await addLabelsToIssue(gh.owner, gh.repoName, gh.issueNumber, input.labels)
    return `Labels added: ${input.labels.join(', ')}`
  },
})

// ─── update_issue_body ────────────────────────────────────────────────────────

registerTool({
  name: 'update_issue_body',
  description:
    'Guarda el resultado del análisis en el issue activo. Funciona para tareas locales y conectadas a GitHub.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID de la tarea — usar el valor de {{task.id}} del prompt.',
      },
      body: {
        type: 'string',
        description: 'Contenido completo en markdown. Reemplaza el body actual del issue.',
      },
    },
    required: ['task_id', 'body'],
  },
  providers: {
    'tmux-claude': { method: 'POST', path: '/api/tools/update_issue_body' },
    'iterm-claude': { method: 'POST', path: '/api/tools/update_issue_body' },
  },
  async execute(input: any, _ctx: ToolContext): Promise<string> {
    const pending = getPendingTask(input.task_id)
    if (!pending) throw new Error(`No hay tarea activa con id '${input.task_id}'`)
    pending.task = await pending.manager.saveOutput(pending.task, input.body)
    pending.broadcast({ type: 'task:updated', task: pending.task })
    return 'Contenido guardado correctamente.'
  },
})

// ─── add_issue_comment ────────────────────────────────────────────────────────

registerTool({
  name: 'add_issue_comment',
  description:
    "Post a comment on a GitHub issue. If issue_node_id is omitted or unknown, the current task's issue is used.",
  input_schema: {
    type: 'object',
    properties: {
      issue_node_id: {
        type: 'string',
        description: "GitHub issue node ID. Omit to use the current task's issue.",
      },
      body: { type: 'string', description: 'Comment body in markdown' },
    },
    required: ['body'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const nodeId =
      input.issue_node_id && input.issue_node_id !== 'unknown'
        ? input.issue_node_id
        : ctx.github?.issueId
    if (!nodeId)
      throw new Error('issue_node_id is required when no GitHub issue context is available')
    await addIssueComment(nodeId, input.body)
    return 'Comment posted'
  },
})
