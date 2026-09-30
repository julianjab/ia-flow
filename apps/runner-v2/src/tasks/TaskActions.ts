/**
 * Lo que una persona hace sobre una tarea desde la bandeja (o confirmando lo que propuso el
 * asistente): mergear, aprobar el PRD, devolverla, contestar y destrabar, relanzar, reintentar o
 * pedirle al agente que pare. Lo que toca GitHub va con el token de ESA persona — el movimiento
 * queda a su nombre en el board — y sólo si la bandeja dice que la acción aplica a la tarea.
 */
import type { PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { UpdateIssueAction, type UpdateIssueInput } from '@ia-flow/github-tools'
import type { TaskAction, TaskActionRequest, TaskActionResult } from '@ia-flow/shared'
import { createLogger } from '@ia-flow/telemetry'
import type { InboxSettings } from '../inbox/InboxSection.js'
import type { InboxService } from '../inbox/InboxService.js'

export interface TaskActionsOptions {
  inbox: Pick<InboxService, 'item'>
  /** El board de cada proyecto: los cambios de Status son campos de ese Project v2. */
  boards: Map<string, { owner: string; number: number }>
  settings: Pick<InboxSettings, 'labels' | 'statuses' | 'mergeMethod'>
  /** Vuelve a despachar el último evento de la tarea (relanzar, reintentar). */
  redispatch(ref: string, by: string): Promise<string>
  /** Le pide al agente que corre para la tarea que termine (suave: lo lee en su próxima vuelta). */
  stop(ref: string, by: string): string
  /** Después de un cambio: que la bandeja relea el board. */
  changed(ref: string): void
  fetchImpl?: typeof fetch
}

/** Una acción que no se puede hacer, con el status HTTP que le corresponde. */
export class TaskActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

interface IssueTarget {
  owner: string
  repo: string
  number: number
}

function parseRef(ref: string): IssueTarget {
  const match = ref.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/)
  if (!match) throw new TaskActionError(`"${ref}" no es owner/repo#n`, 400)
  return { owner: match[1] as string, repo: match[2] as string, number: Number(match[3]) }
}

/** `UpdateIssueAction` fuera de una pipeline: el issue lo fija la bandeja, no un evento. */
const NO_CTX = {} as PipelineExecutionContext

export class TaskActions {
  readonly log = createLogger('runner.task-actions')

  constructor(private readonly options: TaskActionsOptions) {}

  async run(
    ref: string,
    request: TaskActionRequest,
    github: { token: string; login: string },
  ): Promise<TaskActionResult> {
    const item = await this.options.inbox.item(ref)
    if (!item) throw new TaskActionError(`${ref} no está en ningún board de este runner`, 404)
    if (!item.actions.includes(request.action)) {
      throw new TaskActionError(
        `"${request.action}" no aplica a ${ref} ahora (${item.why}). Aplica: ${item.actions.join(', ') || 'nada'}`,
        409,
      )
    }
    const client = new GithubClient({
      auth: new GithubTokenAuth(github.token),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    })
    const board = this.options.boards.get(item.project_id)
    const message = await this.apply(request, ref, client, board, item.pr?.number, github.login)
    this.log.info(`${github.login}: ${request.action} sobre ${ref} → ${message}`, {
      'ia.issue': ref,
      'ia.task_action': request.action,
      'ia.github.login': github.login,
    })
    this.options.changed(ref)
    return { ok: true, message, github_login: github.login }
  }

  private async apply(
    request: TaskActionRequest,
    ref: string,
    client: GithubClient,
    board: { owner: string; number: number } | undefined,
    pr: number | undefined,
    login: string,
  ): Promise<string> {
    const target = parseRef(ref)
    const { labels, statuses } = this.options.settings
    const update = (input: UpdateIssueInput) =>
      new UpdateIssueAction({
        client,
        ...(board ? { project: board } : {}),
        issue: () => target,
      }).execute(input, NO_CTX)
    const action: TaskAction = request.action
    switch (action) {
      case 'merge': {
        if (pr === undefined) throw new TaskActionError(`${ref} no tiene un PR abierto`, 409)
        await client.requestJson(`/repos/${target.owner}/${target.repo}/pulls/${pr}/merge`, {
          method: 'PUT',
          body: JSON.stringify({ merge_method: this.options.settings.mergeMethod }),
        })
        return `PR #${pr} mergeado`
      }
      case 'approve_prd':
        return update({ status: statuses.build })
      case 'back_to_refine':
        return update({ status: statuses.refine })
      case 'answer_and_unblock': {
        const comment = request.comment?.trim()
        if (!comment) throw new TaskActionError('contestar necesita el comentario', 400)
        await client.requestJson(
          `/repos/${target.owner}/${target.repo}/issues/${target.number}/comments`,
          { method: 'POST', body: JSON.stringify({ body: comment }) },
        )
        await update({ removeLabels: [labels.blocked] })
        return `comentado y sin ${labels.blocked}`
      }
      case 'relaunch':
        return this.options.redispatch(ref, login)
      case 'retry': {
        await update({ removeLabels: [labels.blocked] })
        return this.options.redispatch(ref, login)
      }
      case 'stop':
        return this.options.stop(ref, login)
    }
  }
}
