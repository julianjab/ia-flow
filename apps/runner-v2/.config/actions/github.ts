/**
 * Las actions de GitHub sobre el board del proyecto que las pide: las transiciones (`update_issue`,
 * `post_comment` de `@ia-tools/github-tools`) y las tools que un agente pide por id en su YAML —
 * las de `@ia-tools/github-tools` y las de `_lib/github/tools/`, todas `Action` (el mismo objeto
 * sirve de paso de pipeline y de tool del modelo).
 */

import { type ActionContext, defineAction } from '@ia-flow/runner-v2/actions'
import type { Action } from '@ia-tools/agent-engine'
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
} from './_lib/github/tools/index.js'
import { projectOf } from './_lib/project.js'

/** El cliente, el board y el catálogo de repos del proyecto que la pide. */
function projectContext(ctx: ActionContext, action: string): GithubProjectContext {
  const project = projectOf(ctx, action)
  return { client: ctx.services.github, board: project.board, repos: project.repos }
}

/** Una tool que sólo necesita el cliente. */
const withClient = (id: string, create: (ctx: ActionContext) => Action) =>
  defineAction({ id, create })

export default [
  defineAction({
    id: 'update_issue',
    create: (ctx) =>
      new UpdateIssueAction({
        client: ctx.services.github,
        project: projectOf(ctx, 'update_issue').board,
      }),
  }),
  // Con el nombre del agente como encabezado: el reporte de cierre.
  defineAction({
    id: 'post_comment',
    create: (ctx) => {
      if (!ctx.agentId) throw new Error('post_comment firma con el agente: sólo va en un agente')
      return new PostCommentAction({ client: ctx.services.github, heading: ctx.agentId })
    },
  }),
  withClient('react_to_comment', (ctx) => new ReactToCommentAction(ctx.services.github)),
  withClient(
    'update_issue_body',
    (ctx) => new UpdateIssueBodyAction({ client: ctx.services.github }),
  ),
  withClient(
    'list_sub_issues_brief',
    (ctx) => new ListSubIssuesBriefAction({ client: ctx.services.github }),
  ),
  withClient('review_pull_request', (ctx) => new ReviewPullRequestAction(ctx.services.github)),
  withClient('pr_checks', (ctx) => new PrChecksAction(ctx.services.github)),
  withClient('reply_pr_review_thread', (ctx) => new ReplyPrReviewThreadAction(ctx.services.github)),
  withClient(
    'resolve_pr_review_thread',
    (ctx) => new ResolvePrReviewThreadAction(ctx.services.github),
  ),
  defineAction({
    id: 'create_github_issue',
    create: (ctx) => new CreateGithubIssueAction(projectContext(ctx, 'create_github_issue')),
  }),
  defineAction({
    id: 'add_to_project',
    create: (ctx) => new AddToProjectAction(projectContext(ctx, 'add_to_project')),
  }),
  defineAction({
    id: 'add_sub_issue',
    create: (ctx) => new AddSubIssueAction(projectContext(ctx, 'add_sub_issue')),
  }),
  defineAction({
    id: 'mark_blocked_by',
    create: (ctx) => new MarkBlockedByAction(projectContext(ctx, 'mark_blocked_by')),
  }),
  // Lo que el engine hace por el implementer, no el modelo: vincular la rama de la task al issue
  // al arrancar (`onStart`) y garantizar el PR con `Closes #n` al terminar (`done`).
  withClient('link_branch', (ctx) => new LinkBranchAction({ client: ctx.services.github })),
  withClient(
    'ensure_pull_request',
    (ctx) => new EnsurePullRequestAction({ client: ctx.services.github }),
  ),
]
