import type { PipelineExecutionContext } from '@ia-flow/agent-engine'

export interface IssueRef {
  owner: string
  repo: string
  number: number
}

/** De dónde sale el issue sobre el que actúa una acción. Nunca del modelo: una acción de pipeline
 *  actúa sobre el issue del evento, y el modelo no puede redirigirla a otro. */
export type IssueRefResolver = (ctx: PipelineExecutionContext) => IssueRef

/** De dónde sale la rama de la task. Nunca del modelo: una acción de pipeline actúa sobre la
 *  rama que el engine le asignó a la task, no sobre una que el modelo elija. */
export type BranchResolver = (ctx: PipelineExecutionContext) => string

/** De dónde sale el número de PR de la corrida, si hay uno. */
export type PrNumberResolver = (ctx: PipelineExecutionContext) => number | undefined

function payloadOf(ctx: PipelineExecutionContext): Record<string, unknown> {
  const payload = ctx.event.payload
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
}

/** Default: los campos de `GithubIssuePayload` (`@ia-flow/github-webhook`) — `owner`, `repo`,
 *  `number` en el payload del evento. */
export const issueFromPayload: IssueRefResolver = (ctx) => {
  const { owner, repo, number } = payloadOf(ctx)
  if (typeof owner !== 'string' || typeof repo !== 'string' || typeof number !== 'number') {
    throw new Error(
      'GithubAction: el evento no trae owner/repo/number — pasá un `issue` resolver propio',
    )
  }
  return { owner, repo, number }
}

/** Default: `pr.number` o `prNumber` en el payload del evento. */
export const prFromPayload: PrNumberResolver = (ctx) => {
  const payload = payloadOf(ctx)
  const pr = payload.pr as { number?: unknown } | undefined
  const candidate = pr?.number ?? payload.prNumber
  return typeof candidate === 'number' ? candidate : undefined
}

/** Un nombre de rama que se puede mandar a la API sin sorpresas: segmentos `[A-Za-z0-9._-]`
 *  separados por `/`, sin `..`, sin empezar/terminar en `/` ni `.lock`. Más estricto que las
 *  reglas de git a propósito. */
const SAFE_BRANCH = /^(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

export function assertSafeBranch(branch: string): string {
  if (!SAFE_BRANCH.test(branch) || branch.length > 200) {
    throw new Error(`GithubAction: nombre de rama inválido: "${branch}"`)
  }
  return branch
}

/** Default: `task.branch` en el payload del evento — la rama que el engine le asigna a la task. */
export const branchFromPayload: BranchResolver = (ctx) => {
  const task = payloadOf(ctx).task as { branch?: unknown } | undefined
  if (typeof task?.branch !== 'string' || task.branch.length === 0) {
    throw new Error(
      'GithubAction: el evento no trae task.branch — pasá un `branch` resolver propio',
    )
  }
  return assertSafeBranch(task.branch)
}
