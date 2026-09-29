/**
 * El registro de acciones de un proyecto: las transiciones del board (`update_issue`,
 * `post_comment` de `@ia-tools/github-tools`), y las tools que un agente puede pedir por id en su
 * YAML — las de `@ia-tools/github-tools` y las de `./tools/`, todas `Action` (el mismo objeto
 * sirve de paso de pipeline y de tool del modelo).
 *
 * Sin `--live`, TODA escritura a GitHub se simula: las lecturas (GET y queries GraphQL) van a la
 * API real, las escrituras se imprimen y devuelven una respuesta falsa. Así se prueba el ruteo
 * completo contra issues reales sin tocar el board.
 */
import type { Action } from '@ia-tools/agent-engine'
import type { GithubClient } from '@ia-tools/github-api'
import {
  EnsurePullRequestAction,
  LinkBranchAction,
  ListSubIssuesBriefAction,
  PostCommentAction,
  UpdateIssueAction,
  UpdateIssueBodyAction,
} from '@ia-tools/github-tools'
import {
  AddSubIssueAction,
  AddToProjectAction,
  CreateGithubIssueAction,
  type GithubProjectContext,
  MarkBlockedByAction,
  PrChecksAction,
  ReactToCommentAction,
  ReplyPrReviewThreadAction,
  ResolvePrReviewThreadAction,
  ReviewPullRequestAction,
} from './tools/index.js'

function fakeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** La respuesta falsa de una escritura simulada, con la forma que espera quien la pidió. */
function simulatedResponse(url: string, method: string): Response {
  if (url.endsWith('/graphql')) return fakeResponse({ data: { simulated: true } })
  if (url.endsWith('/comments')) return fakeResponse({ html_url: '(comentario simulado)' }, 201)
  if (method === 'DELETE') return new Response(null, { status: 204 })
  return fakeResponse(url.endsWith('/labels') ? [] : {})
}

/** `fetch` que deja pasar lecturas y simula escrituras, imprimiendo cada una. */
export function simulatedWritesFetch(log: (line: string) => void): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? init.body : undefined
    const isGraphqlRead = url.endsWith('/graphql') && !body?.includes('mutation')
    if (method === 'GET' || isGraphqlRead) return fetch(input, init)

    log(
      `[simulado] ${method} ${url.replace('https://api.github.com', '')}${body ? ` ${body}` : ''}`,
    )
    return simulatedResponse(url, method)
  }) as typeof fetch
}

export interface BoardActions {
  /** El cliente con la identidad del runner (y el modo simulado, si aplica). */
  client: GithubClient
  updateIssue: UpdateIssueAction
  /** `post_comment` con el nombre del agente como encabezado — el reporte de cierre. */
  postComment: (agentId: string) => PostCommentAction
  /** Las tools de ia-flow que el modelo llama por nombre, implementadas como `Action`. */
  tools: Map<string, Action>
}

export function buildBoardActions(
  client: GithubClient,
  board: GithubProjectContext['board'],
  /** El catálogo de repos del proyecto: donde las tools pueden crear y enlazar issues. */
  repos: GithubProjectContext['repos'],
): BoardActions {
  const project: GithubProjectContext = { client, board, repos }
  return {
    client,
    updateIssue: new UpdateIssueAction({ client, project: board }),
    postComment: (agentId) => new PostCommentAction({ client, heading: agentId }),
    tools: new Map<string, Action>(
      [
        new ReactToCommentAction(client),
        new UpdateIssueBodyAction({ client }),
        new ListSubIssuesBriefAction({ client }),
        new ReviewPullRequestAction(client),
        new PrChecksAction(client),
        new ReplyPrReviewThreadAction(client),
        new ResolvePrReviewThreadAction(client),
        new CreateGithubIssueAction(project),
        new AddToProjectAction(project),
        new AddSubIssueAction(project),
        new MarkBlockedByAction(project),
        // Lo que el engine hace por el implementer, no el modelo: vincular la rama de la task al
        // issue al arrancar (`onStart`) y garantizar el PR con `Closes #n` al terminar (`done`).
        new LinkBranchAction({ client }),
        new EnsurePullRequestAction({ client }),
      ].map((action) => [action.id, action]),
    ),
  }
}
