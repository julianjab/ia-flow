import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import {
  type IssueRefResolver,
  issueFromPayload,
  type PrNumberResolver,
  prFromPayload,
} from './issueRef.js'

/** Una condición que no se cumple, con el status HTTP que le corresponde (409): quien la muestra
 *  —la bandeja— la devuelve tal cual en vez de tratarla como un fallo del runner. */
export class PreconditionError extends Error {
  readonly status = 409
}

/** Por qué GitHub no deja mergear un PR, según su `mergeable_state`. */
const UNMERGEABLE: Record<string, string> = {
  blocked: 'le faltan checks o reviews requeridos',
  dirty: 'tiene conflictos con la rama base',
  behind: 'está desactualizado respecto a la rama base',
  draft: 'es un borrador',
  unknown: 'GitHub todavía está calculando su estado, reintentá en unos segundos',
}

interface Options {
  client: GithubClient
  issue?: IssueRefResolver
  pr?: PrNumberResolver
}

function target(options: Options, ctx: PipelineExecutionContext) {
  const issue = (options.issue ?? issueFromPayload)(ctx)
  const pr = (options.pr ?? prFromPayload)(ctx)
  if (pr === undefined) {
    throw new PreconditionError(
      `${issue.owner}/${issue.repo}#${issue.number} no tiene un PR abierto`,
    )
  }
  return { owner: issue.owner, repo: issue.repo, pr }
}

/**
 * Que el PR esté apto para mergear según GitHub ANTES de pedir el merge. El `PUT /merge` con el
 * token de un admin se salta la branch protection cuando `enforce_admins` está apagado (en la web
 * pide marcar "merge without waiting"; la API no): un merge que pasa por una persona no puede
 * depender de esa config. `unstable` (fallan checks NO requeridos) sí pasa: GitHub también lo deja
 * mergear.
 */
export class CheckPrMergeableAction extends Action<z.ZodObject<{}>> {
  readonly description = 'Verifica con GitHub que el PR de la tarea se puede mergear.'
  readonly input = z.strictObject({})
  override readonly sideEffects = 'none' as const
  constructor(private readonly options: Options) {
    super({ id: 'check_pr_mergeable' })
  }

  async execute(_input: object, ctx: PipelineExecutionContext): Promise<string> {
    const { owner, repo, pr } = target(this.options, ctx)
    const data = await this.options.client.requestJson<{
      mergeable_state?: string
      draft?: boolean
    }>(`/repos/${owner}/${repo}/pulls/${pr}`)
    const state = data.draft ? 'draft' : (data.mergeable_state ?? 'unknown')
    const reason = UNMERGEABLE[state]
    if (reason) throw new PreconditionError(`PR #${pr} no se puede mergear: ${reason} (${state})`)
    return `PR #${pr} apto para mergear (${state})`
  }
}

export const MergePullRequestInput = z.strictObject({
  method: z.enum(['merge', 'squash', 'rebase']).default('squash'),
})
export type MergePullRequestInput = z.infer<typeof MergePullRequestInput>

/** Mergea el PR de la tarea. Escribe: un agente no la recibe como tool salvo que se la habiliten. */
export class MergePullRequestAction extends Action<typeof MergePullRequestInput> {
  readonly description = 'Mergea el PR de la tarea con el método indicado.'
  readonly input = MergePullRequestInput
  constructor(private readonly options: Options) {
    super({ id: 'merge_pr' })
  }

  async execute(input: MergePullRequestInput, ctx: PipelineExecutionContext): Promise<string> {
    const { owner, repo, pr } = target(this.options, ctx)
    await this.options.client.requestJson(`/repos/${owner}/${repo}/pulls/${pr}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ merge_method: input.method }),
    })
    return `PR #${pr} mergeado (${input.method})`
  }
}
