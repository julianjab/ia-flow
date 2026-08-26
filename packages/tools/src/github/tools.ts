// GitHub-only tools — create issues, link to project, sub-issues.
// Task-scoped tools (update body, comments, fields, labels) live in tools/task.ts
// and route through TransitionManager so they work for any source.

import {
  type GitHubToolContext,
  addProjectItem,
  addSubIssue,
  createIssue,
  replyToReviewThread,
  resolveReviewThread,
} from '@ia-flow/issue-sources'
import type { RepoResolverPort, ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'

export type { GitHubToolContext } from '@ia-flow/issue-sources'

let repoResolver: RepoResolverPort | null = null

/** Wired by apps/server's composition/container.ts at startup — same
 *  pattern as `workspace/`'s `setWorkspaceManagerPort`. */
export function setRepoResolverPort(port: RepoResolverPort | null): void {
  repoResolver = port
}

function requireRepoResolver(): RepoResolverPort {
  if (!repoResolver)
    throw new Error('RepoResolverPort not wired — call setRepoResolverPort() at startup')
  return repoResolver
}

function requireGitHub(ctx: ToolContext): GitHubToolContext {
  // Only `owner` is guaranteed across every GitHub-backed source — a
  // `github-issues` project has no Projects v2 board, so `projectId` is
  // absent there by design (see GitHubIssueTaskSource.getSourceToolContext).
  // Tools that specifically need a board (add_to_project) check `projectId`
  // themselves instead of relying on this guard for it.
  const source = ctx.sourceContext as GitHubToolContext | undefined
  if (!source?.owner)
    throw new Error('GitHub context not available — is this a GitHub-connected project?')
  return source
}

// ─── create_github_issue ──────────────────────────────────────────────────────

registerTool({
  name: 'create_github_issue',
  description:
    'Create a new GitHub issue in the given repo. If the project has a Projects v2 board, follow up with add_to_project to make it visible there. Returns the created issue number and node ID.',
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
      labels: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Opcional. Labels a aplicar al crear el issue — imprescindible en sources que seleccionan issues por label (ej. github-issues: label ancla + status inicial), si no el issue nuevo queda invisible para el engine hasta que alguien lo etiquete a mano.',
      },
    },
    required: ['repo', 'title', 'body'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const gh = requireGitHub(ctx)
    const { owner, repo } = await requireRepoResolver().resolveGithubRepo(input.repo, gh.owner)
    const issue = await createIssue(owner, repo, input.title, input.body, input.labels)
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
    if (!gh.projectId)
      throw new Error(
        'add_to_project requires a GitHub Projects v2 board — this source has none (no projectId in context). Not applicable for github-issues projects.',
      )
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
    const { owner, repo } = await requireRepoResolver().resolveGithubRepo(
      input.parent_repo,
      gh.owner,
    )
    await addSubIssue(owner, repo, input.parent_issue_number, input.child_numeric_id)
    return `Sub-issue linked: #${input.child_numeric_id} → parent #${input.parent_issue_number}`
  },
})

// ─── Review threads ───────────────────────────────────────────────────────────
//
// La contracara escribible de las reviews que `fetchConversation` inyecta en
// `{{task.comments}}`. La lectura la hace el engine (garantizada, con ventana
// de recencia); responder y resolver sólo puede ser una tool, porque son
// acciones que el agente decide despues de arreglar el código.
//
// El `thread_id` NO se lo inventa el modelo: se lo dio la propia inyección
// (`TaskComment.threadId`), así que la tool no necesita buscar nada — es el
// mismo dato viajando de vuelta.

registerTool({
  name: 'reply_pr_review_thread',
  description:
    'Responde DENTRO de un hilo de review de un Pull Request, donde el reviewer dejó el comentario. Usa el `thread_id` que viene en el comentario de review que leíste en el contexto de la tarea. Es lo que hace que tu respuesta quede junto al pedido, en vez de suelta en la conversación general del PR.',
  input_schema: {
    type: 'object',
    properties: {
      thread_id: {
        type: 'string',
        description:
          'Id del hilo de review, tal como aparece en el comentario que estás contestando.',
      },
      body: {
        type: 'string',
        description:
          'Tu respuesta en markdown: qué hiciste con el pedido, o por qué no aplica. Sé concreto — el reviewer lo lee al lado de su propio comentario.',
      },
    },
    required: ['thread_id', 'body'],
  },
  async execute(input: any): Promise<string> {
    await replyToReviewThread(input.thread_id, input.body)
    return `Respuesta publicada en el hilo de review ${input.thread_id}.`
  },
})

registerTool({
  name: 'resolve_pr_review_thread',
  description:
    'Marca como resuelto un hilo de review de un Pull Request. Úsalo SÓLO cuando el pedido está efectivamente atendido en el código que pusheaste — un hilo sin resolver es lo que hace que el pedido te vuelva a aparecer en la próxima corrida, así que resolverlo de más equivale a perder el feedback. Si dudas, respondé con reply_pr_review_thread y dejalo abierto.',
  input_schema: {
    type: 'object',
    properties: {
      thread_id: {
        type: 'string',
        description: 'Id del hilo de review a resolver.',
      },
    },
    required: ['thread_id'],
  },
  async execute(input: any): Promise<string> {
    await resolveReviewThread(input.thread_id)
    return `Hilo de review ${input.thread_id} marcado como resuelto.`
  },
})
