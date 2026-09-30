/**
 * Lo que una persona hace sobre una tarea desde la bandeja (o confirmando lo que propuso el
 * asistente): mergear, aprobar el PRD, devolverla, contestar y destrabar, relanzar, reintentar,
 * re-ejecutar el review o pedirle al agente que pare. Lo que toca GitHub va con el token de ESA persona — el movimiento
 * queda a su nombre en el board — y sólo si la bandeja dice que la acción aplica a la tarea.
 */
import type { PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { UpdateIssueAction, type UpdateIssueInput } from '@ia-flow/github-tools'
import type { TaskAction, TaskActionRequest, TaskActionResult } from '@ia-flow/shared'
import { createLogger } from '@ia-flow/telemetry'
import type { InboxSettings } from './InboxSection.js'
import type { InboxService } from './InboxService.js'

export interface TaskActionsOptions {
  inbox: Pick<InboxService, 'item'>
  /** El board de cada proyecto: los cambios de Status son campos de ese Project v2. */
  boards: Map<string, { owner: string; number: number }>
  /** La label que marca las cards de cada proyecto (`project.yaml` → `label`). Si es la misma
   *  que la de "bloqueada", sacarla le entregaría la card a otro engine: no se toca. */
  projectLabels?: Map<string, string>
  settings: Pick<InboxSettings, 'labels' | 'statuses' | 'mergeMethod'>
  /** Vuelve a despachar el último evento de la tarea (relanzar, reintentar). */
  redispatch(ref: string, by: string): Promise<string>
  /** Vuelve a correr el pipeline de Review, como si la card acabara de llegar ahí. */
  rerunReview(ref: string, by: string): Promise<string>
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

/**
 * Que quien pide la acción pueda escribir en el repo de la tarea, preguntándole a GitHub con SU
 * token. Sin esto, relanzar o parar (que no tocan GitHub) los podría pedir cualquier cuenta: el
 * runner los hace con su propia identidad.
 */
async function assertCanPush(
  client: GithubClient,
  target: IssueTarget,
  login: string,
): Promise<void> {
  const res = await client.request(`/repos/${target.owner}/${target.repo}`)
  const repo = res.ok ? ((await res.json()) as { permissions?: { push?: boolean } }) : undefined
  if (!repo?.permissions?.push) {
    throw new TaskActionError(
      `${login} no tiene permiso de escritura en ${target.owner}/${target.repo}`,
      403,
    )
  }
}

/** Por qué GitHub no deja mergear un PR, según su `mergeable_state`. */
const UNMERGEABLE: Record<string, string> = {
  blocked: 'le faltan checks o reviews requeridos',
  dirty: 'tiene conflictos con la rama base',
  behind: 'está desactualizado respecto a la rama base',
  draft: 'es un borrador',
  unknown: 'GitHub todavía está calculando su estado, reintentá en unos segundos',
}

/**
 * Que el PR esté apto para mergear según GitHub ANTES de pedir el merge. El `PUT /merge` con el
 * token de un admin se salta la branch protection cuando `enforce_admins` está apagado (en la web
 * pide marcar "merge without waiting"; la API no): la bandeja no puede depender de esa config.
 * `unstable` (fallan checks NO requeridos) sí pasa: GitHub también lo deja mergear.
 */
async function assertMergeable(
  client: GithubClient,
  target: IssueTarget,
  pr: number,
): Promise<void> {
  const data = await client.requestJson<{ mergeable_state?: string; draft?: boolean }>(
    `/repos/${target.owner}/${target.repo}/pulls/${pr}`,
  )
  const state = data.draft ? 'draft' : (data.mergeable_state ?? 'unknown')
  const reason = UNMERGEABLE[state]
  if (reason) {
    throw new TaskActionError(`PR #${pr} no se puede mergear: ${reason} (${state})`, 409)
  }
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
    // Lo que se puede rechazar sin preguntarle nada a GitHub, antes.
    if (request.action === 'answer_and_unblock' && !request.comment?.trim()) {
      throw new TaskActionError('contestar necesita el comentario', 400)
    }
    await assertCanPush(client, parseRef(ref), github.login)
    const board = this.options.boards.get(item.project_id)
    const unblocks =
      this.options.projectLabels?.get(item.project_id) !== this.options.settings.labels.blocked
    const message = await this.apply(request, ref, client, {
      board,
      pr: item.pr?.number,
      login: github.login,
      unblocks,
    })
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
    {
      board,
      pr,
      login,
      unblocks,
    }: {
      board: { owner: string; number: number } | undefined
      pr: number | undefined
      login: string
      /** Si sacar la label de "bloqueada" es seguro (ver `projectLabels`). */
      unblocks: boolean
    },
  ): Promise<string> {
    const target = parseRef(ref)
    const { labels, statuses } = this.options.settings
    const update = (input: UpdateIssueInput) =>
      new UpdateIssueAction({
        client,
        ...(board ? { project: board } : {}),
        issue: () => target,
      }).execute(input, NO_CTX)
    const unblock = async () => {
      if (unblocks) await update({ removeLabels: [labels.blocked] })
    }
    const action: TaskAction = request.action
    switch (action) {
      case 'merge': {
        if (pr === undefined) throw new TaskActionError(`${ref} no tiene un PR abierto`, 409)
        await assertMergeable(client, target, pr)
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
        const comment = request.comment?.trim() ?? ''
        await client.requestJson(
          `/repos/${target.owner}/${target.repo}/issues/${target.number}/comments`,
          { method: 'POST', body: JSON.stringify({ body: comment }) },
        )
        await unblock()
        return unblocks ? `comentado y sin ${labels.blocked}` : 'comentado'
      }
      case 'relaunch':
        return this.options.redispatch(ref, login)
      case 'retry': {
        await unblock()
        return this.options.redispatch(ref, login)
      }
      case 'stop':
        return this.options.stop(ref, login)
      case 'rerun_review':
        return this.options.rerunReview(ref, login)
    }
  }
}
