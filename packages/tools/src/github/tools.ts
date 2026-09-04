// GitHub-only tools — create issues, link to project, sub-issues.
// Task-scoped tools (update body, comments, fields, labels) live in tools/task.ts
// and route through TransitionManager so they work for any source.

import {
  type GitHubToolContext,
  type ReactionName,
  addProjectItem,
  addSubIssue,
  createIssue,
  listSubIssues,
  reactToComment,
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

// ─── list_sub_issues_brief ────────────────────────────────────────────────────
//
// La contraparte de LECTURA de `add_sub_issue`, y la razón de que exista pese
// a que el MCP de GitHub ya trae un `list_sub_issues`: aquél devuelve los
// issues ENTEROS. En `la-haus/subscriptions#1243` son 21 hijos, ~154K
// caracteres sólo de bodies más el envoltorio JSON de cada uno — una sola
// llamada le comía al refiner media ventana de contexto y el run terminaba
// fallando sin haber abierto un archivo del repo.
//
// El nombre lleva `_brief` a propósito: convive con el `list_sub_issues` del
// MCP (que va server-side vía `mcp_servers`, fuera de este registry), y dos
// tools homónimas con contratos distintos serían una ambigüedad para el
// modelo justo donde queremos que elija la barata.

registerTool({
  name: 'list_sub_issues_brief',
  description:
    'Índice compacto de los sub-issues de un issue padre: número, título, estado y url — SIN los bodies. Es la forma barata de ver qué hermanos existen y decidir a cuál vale la pena leerle el body después (eso se pide aparte). Preferila al list_sub_issues del MCP de GitHub, que devuelve los issues completos y en una épica grande agota el contexto.',
  input_schema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description:
          'Repo name (e.g. "subscriptions") donde vive el issue padre. El owner sale del contexto del proyecto.',
      },
      parent_issue_number: { type: 'number', description: 'Número del issue padre' },
    },
    required: ['repo', 'parent_issue_number'],
  },
  async execute(input: any, ctx: ToolContext): Promise<string> {
    const gh = requireGitHub(ctx)
    const { owner, repo } = await requireRepoResolver().resolveGithubRepo(input.repo, gh.owner)
    const subIssues = await listSubIssues(owner, repo, input.parent_issue_number)
    return JSON.stringify({ count: subIssues.length, subIssues })
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

// ─── react_to_comment ──────────────────────────────────────────────────────
//
// La alternativa barata a comentar: para un agente que sólo clasifica (ej.
// `comment-triage`), dejar OTRO comentario por cada comentario humano es
// ruido — un hilo se llena de "procesado" sin ningún hallazgo adentro. Una
// reacción en el comentario original acusa recibo sin agregar una línea a la
// conversación. Combinar con `comment: none` en el agente (o la salida) para
// que el auto-comment de cierre del run tampoco se publique — si no, esta
// tool sólo AGREGA una reacción encima del comentario de sistema de siempre.

const REACTION_NAMES: readonly ReactionName[] = [
  '+1',
  '-1',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes',
]

registerTool({
  name: 'react_to_comment',
  description:
    'Deja una reacción de emoji sobre un comentario existente de un issue o PR de GitHub, en vez de escribir un comentario nuevo. Usalo para acusar recibo de un comentario humano sin agregar ruido a la conversación — típicamente 👍 (+1) cuando lo tomaste en cuenta, 👎 (-1) cuando lo evaluaste y no aplica. Necesita el node id del comentario, no el número de issue.',
  input_schema: {
    type: 'object',
    properties: {
      comment_node_id: {
        type: 'string',
        description:
          'Node id (GraphQL) del comentario a reaccionar, tal como viene en el contexto de la tarea (ej. {{event.payload.commentId}}). NO es el número del issue ni la URL del comentario.',
      },
      reaction: {
        type: 'string',
        enum: REACTION_NAMES as unknown as string[],
        description:
          "Qué reacción dejar. '+1' para 'tomé este comentario en cuenta', '-1' para 'lo evalué y no requiere acción'.",
      },
    },
    required: ['comment_node_id', 'reaction'],
  },
  async execute(input: any): Promise<string> {
    // El `enum` del schema ya restringe al modelo, pero un valor fuera de
    // rango (o un provider async que no valida contra el schema antes de
    // ejecutar) tiene que fallar acá con un motivo legible — no como el
    // `content: undefined` crudo que devolvería la mutación de GraphQL.
    if (!REACTION_NAMES.includes(input.reaction)) {
      throw new Error(
        `Reacción inválida '${input.reaction}' — debe ser una de: ${REACTION_NAMES.join(', ')}.`,
      )
    }
    await reactToComment(input.comment_node_id, input.reaction as ReactionName)
    return `Reacción '${input.reaction}' agregada al comentario ${input.comment_node_id}.`
  },
})
