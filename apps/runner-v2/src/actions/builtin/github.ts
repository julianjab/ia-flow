/**
 * Las actions de GitHub sobre el board del proyecto que las pide: las transiciones (`update_issue`,
 * `post_comment` de `@ia-flow/github-tools`) y las tools que un agente pide por id en su YAML —
 * las de `@ia-flow/github-tools`, todas `Action` (el mismo objeto
 * sirve de paso de pipeline y de tool del modelo).
 */

import type { Action } from '@ia-flow/agent-engine'
import {
  AddSubIssueAction,
  AddToProjectAction,
  ApprovePullRequestAction,
  CheckPrMergeableAction,
  CreateGithubIssueAction,
  DismissPullRequestApprovalAction,
  EnsurePullRequestAction,
  type GithubProjectContext,
  LinkBranchAction,
  ListSubIssuesBriefAction,
  MarkBlockedByAction,
  MergePullRequestAction,
  PostCommentAction,
  PostUserCommentAction,
  PrChecksAction,
  ReactToCommentAction,
  RemoveBlockedByAction,
  ReplyPrReviewThreadAction,
  RequestChangesPullRequestAction,
  ResolvePrReviewThreadAction,
  RetargetPullRequestAction,
  ReviewPullRequestAction,
  UpdateIssueAction,
  UpdateIssueBodyAction,
  ViewImageAction,
} from '@ia-flow/github-tools'
import { type ActionContext, defineAction } from '../defineAction.js'
import { projectOf } from './project.js'

/** El cliente, el board y el catálogo de repos del proyecto que la pide. */
function projectContext(ctx: ActionContext, action: string): GithubProjectContext {
  const project = projectOf(ctx, action)
  return {
    client: ctx.services.github,
    board: project.board,
    adder: ctx.services.boards.of(project.id),
    repos: project.repos,
  }
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
        board: ctx.services.boards.of(projectOf(ctx, 'update_issue').id),
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
  // Sin firma de agente: un aviso del runner que corre fuera de un agente — el `onInterrupt` del
  // proyecto (quién se interrumpió va en el texto). Lleva la marca `<!-- ia-flow:` igual que un
  // reporte, así la regla de comentarios no lo toma por un pedido humano.
  withClient(
    'post_notice',
    (ctx) => new PostCommentAction({ client: ctx.services.github, id: 'post_notice' }),
  ),
  // El comentario de una persona (la bandeja: responder y destrabar), a su nombre y sin la marca
  // del engine: cuenta como un comentario humano.
  withClient(
    'post_user_comment',
    (ctx) =>
      new PostUserCommentAction({
        client: ctx.services.github,
        onPosted: (id) => ctx.services.userComments.note(id),
      }),
  ),
  // Mergear el PR de la tarea (la bandeja): primero se verifica con GitHub que se puede.
  withClient(
    'check_pr_mergeable',
    (ctx) => new CheckPrMergeableAction({ client: ctx.services.github }),
  ),
  withClient('merge_pr', (ctx) => new MergePullRequestAction({ client: ctx.services.github })),
  withClient('react_to_comment', (ctx) => new ReactToCommentAction(ctx.services.github)),
  // Una imagen para el modelo (`toolContent`): de un repo de los proyectos del runner, con su
  // credencial, o de los hosts de Figma (`options.hosts` los pisa). La usa el asistente de diseño.
  defineAction({
    id: 'view_image',
    create: (ctx) => {
      const repos = new Set(
        ctx
          .projects()
          .flatMap((project) =>
            project.repos.map((r) =>
              `${r.githubOwner ?? project.board.owner}/${r.githubRepo ?? r.name}`.toLowerCase(),
            ),
          ),
      )
      const hosts = Array.isArray(ctx.options.hosts)
        ? ctx.options.hosts.filter((h): h is string => typeof h === 'string')
        : undefined
      return new ViewImageAction({
        client: ctx.services.github,
        allowRepo: (owner, repo) => repos.has(`${owner}/${repo}`.toLowerCase()),
        ...(hosts ? { hosts } : {}),
      })
    },
  }),
  withClient(
    'update_issue_body',
    // El link del hilo de review (`request_slack_review`) sobrevive a que un agente reescriba el PRD.
    (ctx) => new UpdateIssueBodyAction({ client: ctx.services.github, keepSections: ['slack'] }),
  ),
  withClient(
    'list_sub_issues_brief',
    (ctx) => new ListSubIssuesBriefAction({ client: ctx.services.github }),
  ),
  withClient('review_pull_request', (ctx) => new ReviewPullRequestAction(ctx.services.github)),
  withClient('approve_pull_request', (ctx) => new ApprovePullRequestAction(ctx.services.github)),
  withClient(
    'request_changes_pull_request',
    (ctx) => new RequestChangesPullRequestAction(ctx.services.github),
  ),
  withClient(
    'dismiss_pull_request_approval',
    (ctx) => new DismissPullRequestApprovalAction(ctx.services.github),
  ),
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
    create: (ctx) =>
      new AddToProjectAction({
        ...projectContext(ctx, 'add_to_project'),
        writer: ctx.services.boards.of(projectOf(ctx, 'add_to_project').id),
      }),
  }),
  defineAction({
    id: 'add_sub_issue',
    create: (ctx) => new AddSubIssueAction(projectContext(ctx, 'add_sub_issue')),
  }),
  defineAction({
    id: 'mark_blocked_by',
    create: (ctx) => new MarkBlockedByAction(projectContext(ctx, 'mark_blocked_by')),
  }),
  defineAction({
    id: 'remove_blocked_by',
    create: (ctx) => new RemoveBlockedByAction(projectContext(ctx, 'remove_blocked_by')),
  }),
  // Lo que el engine hace por el implementer, no el modelo: vincular la rama de la task al issue
  // al arrancar (`onStart`) y garantizar el PR con `Closes #n` al terminar (`done`).
  withClient('link_branch', (ctx) => new LinkBranchAction({ client: ctx.services.github })),
  withClient(
    'ensure_pull_request',
    (ctx) => new EnsurePullRequestAction({ client: ctx.services.github }),
  ),
  // Un PR apilado cuya base se mergeó (`issue.base_merged`): a la rama en la que entró.
  withClient(
    'retarget_pr',
    (ctx) => new RetargetPullRequestAction({ client: ctx.services.github }),
  ),
]
