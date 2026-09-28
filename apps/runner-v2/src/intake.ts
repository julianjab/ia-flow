/**
 * Las pipelines de ENTRADA: cómo un webhook crudo de GitHub se convierte en el evento que
 * escuchan las reglas de `config/rules/`. El servidor publica cada delivery tal cual llegó, como
 * `github.<X-GitHub-Event>`; acá, por evento:
 *
 *   on / when   qué deliveries importan — filtros declarativos sobre el payload CRUDO, sin I/O
 *   resolve     la Action de `actions/` que lee lo que falta (proyecto, task, board) y arma el
 *               payload completo que ve el agente
 *   emit        publica ese payload con el nombre que escuchan las reglas y el `projectId` ya
 *               resuelto como scope — un `EmitAction` por nombre posible, cada uno con su `when`
 *
 * Son pipelines sin scope (el evento crudo todavía no sabe de qué proyecto es) y las reglas son
 * pipelines con scope (fail-closed ante un evento sin él): un evento crudo nunca llega a una
 * regla, y uno emitido nunca vuelve a entrar acá (los nombres no se pisan).
 */
import {
  Condition,
  type ConditionRow,
  EmitAction,
  Pipeline,
  type PipelineExecutionContext,
  type Runnable,
} from '@ia-tools/agent-pipeline'
import {
  type IntakeContext,
  type Resolution,
  ResolveCiRunAction,
  ResolveIssueCommentAction,
  ResolveProjectItemAction,
  ResolvePullRequestAction,
} from './actions/index.js'

/** El prefijo de los eventos crudos que publica el servidor de webhooks. */
export const RAW_PREFIX = 'github.'

type Resolved = Extract<Resolution, { emit: string }>
const resolved = (ctx: PipelineExecutionContext) => ctx.steps.resolve as Resolved

/** Publica lo que resolvió `resolve`, si eligió este `type`. */
function emitAs(type: string): EmitAction {
  return new EmitAction({
    type,
    when: Condition.fromRows([{ field: 'steps.resolve.emit', op: 'eq', value: type }]),
    payload: (ctx) => resolved(ctx).payload,
    // `repo`/`issue` además del proyecto: la telemetría los hereda a todo lo que corre debajo, y es
    // por lo que se filtra en Grafana (el delivery crudo de un project item no los trae).
    scope: (ctx) => {
      const { projectId, task, payload } = resolved(ctx)
      const repo = `${payload.owner}/${payload.repo}`
      return { projectId, repo, issue: task }
    },
  })
}

function intake(event: string, resolve: Runnable, emits: string[], when: ConditionRow[] = []) {
  return new Pipeline({
    id: `intake:${event}`,
    on: [`${RAW_PREFIX}${event}`],
    when: Condition.fromRows(when),
    do: [resolve, ...emits.map(emitAs)],
  })
}

export function intakePipelines(ctx: IntakeContext): Pipeline[] {
  return [
    intake(
      'projects_v2_item',
      new ResolveProjectItemAction(ctx),
      ['issue.created', 'issue.status_changed', 'projects_v2_item.edited'],
      [
        { field: 'action', op: 'in', value: ['created', 'edited'] },
        { field: 'projects_v2_item.content_type', op: 'eq', value: 'Issue' },
      ],
    ),
    intake('issue_comment', new ResolveIssueCommentAction(ctx), ['issue_comment']),
    intake('pull_request', new ResolvePullRequestAction(ctx, 'pull_request'), ['pull_request']),
    intake('pull_request_review', new ResolvePullRequestAction(ctx, 'pull_request_review'), [
      'pull_request_review',
    ]),
    // El CI manda decenas de deliveries por push (requested, in_progress, …) y las reglas sólo
    // escuchan `completed`: el filtro va acá, antes de cualquier lectura del board.
    intake(
      'check_suite',
      new ResolveCiRunAction(ctx, 'check_suite'),
      ['check_suite'],
      [{ field: 'action', op: 'eq', value: 'completed' }],
    ),
    intake(
      'workflow_run',
      new ResolveCiRunAction(ctx, 'workflow_run'),
      ['workflow_run'],
      [{ field: 'action', op: 'eq', value: 'completed' }],
    ),
  ]
}
