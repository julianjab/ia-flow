/**
 * La aprobación formal del PR con el token de la App, como PASO de una pipeline (la ruta de un gate
 * que ya aprobó), nunca como tool del modelo: quien decide aprobar es la configuración del deploy,
 * no un agente. Va con su par, que retira las aprobaciones de la App cuando el PR vuelve a revisión.
 */
import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { prFrom } from './pr-ref.js'

/** Marca de las aprobaciones de ia-flow: con ella el par las encuentra para retirarlas (la API
 *  lista los reviews de todos, y el login de la App no se conoce desde acá). */
export const APPROVAL_MARKER = '<!-- ia-flow:approval -->'

/** Los reviews que traban o destraban el merge: los que el retiro levanta. */
const VERDICTS = new Set(['APPROVED', 'CHANGES_REQUESTED'])

/** GitHub no deja aprobar un PR propio: el PR lo abrió la misma App. No es un error del runner. */
const OWN_PR = /422[\s\S]*approve your own pull request/i

export const ApprovePullRequestInput = z.strictObject({
  body: z
    .string()
    .min(1)
    .default('Aprobado por el gate de ia-flow.')
    .describe('El texto del review de aprobación'),
})
export type ApprovePullRequestInput = z.infer<typeof ApprovePullRequestInput>

/**
 * Aprueba el PR del evento, fijado al commit que vio el gate (`commit_id`): si después entró otro
 * commit, la aprobación queda sobre el que se revisó. Un PR de la propia App no se puede aprobar:
 * eso se informa y no tira, así el gate no termina bloqueando la card por algo esperable.
 */
export class ApprovePullRequestAction extends Action<typeof ApprovePullRequestInput> {
  readonly description = 'Aprueba el PR de la tarea (un review APPROVE con el token de la App).'
  readonly input = ApprovePullRequestInput

  constructor(private readonly client: GithubClient) {
    super({ id: 'approve_pull_request' })
  }

  async execute(input: ApprovePullRequestInput, ctx: PipelineExecutionContext): Promise<string> {
    const pr = prFrom(ctx)
    // Un push durante el gate: lo revisado ya no es el PR. Una aprobación sobre el commit viejo
    // seguiría contando en un repo sin "dismiss stale approvals", así que no se aprueba.
    const current = await this.client.requestJson<{ head?: { sha?: string } }>(
      `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
    )
    const head = current.head?.sha
    if (head && head !== pr.sha) {
      return `PR #${pr.number} sin aprobar: el gate revisó ${pr.sha.slice(0, 7)} y el PR ya está en ${head.slice(0, 7)}`
    }
    const payload = JSON.stringify({
      commit_id: pr.sha,
      event: 'APPROVE',
      body: `${input.body.trim()}\n\n${APPROVAL_MARKER}`,
    })
    try {
      const review = await this.client.requestJson<{ html_url?: string }>(
        `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
        { method: 'POST', body: payload },
      )
      return `PR #${pr.number} aprobado sobre ${pr.sha.slice(0, 7)}${
        review.html_url ? `: ${review.html_url}` : ''
      }`
    } catch (err) {
      if (!OWN_PR.test(err instanceof Error ? err.message : String(err))) throw err
      return `PR #${pr.number} sin aprobar: lo abrió la misma App y GitHub no deja aprobar un PR propio`
    }
  }
}

/** Tampoco deja pedir cambios en un PR propio. */
const OWN_PR_CHANGES = /422[\s\S]*request changes on your own pull request/i

export const RequestChangesPullRequestInput = z.strictObject({
  body: z
    .string()
    .min(1)
    .default(
      'El gate de ia-flow pide cambios: los hallazgos están en las conversaciones de este PR.',
    )
    .describe('El texto del review que pide cambios'),
})
export type RequestChangesPullRequestInput = z.infer<typeof RequestChangesPullRequestInput>

/**
 * Pide cambios en el PR del evento (un review `REQUEST_CHANGES` con la marca de ia-flow), fijado
 * al commit que vio el gate: la contracara de `approve_pull_request` cuando el gate no pasa. El
 * retiro (`dismiss_pull_request_approval`) también lo levanta al empezar otro gate. Un PR de la
 * propia App se informa sin tirar.
 */
export class RequestChangesPullRequestAction extends Action<typeof RequestChangesPullRequestInput> {
  readonly description =
    'Pide cambios en el PR de la tarea (un review REQUEST_CHANGES con el token de la App).'
  readonly input = RequestChangesPullRequestInput

  constructor(private readonly client: GithubClient) {
    super({ id: 'request_changes_pull_request' })
  }

  async execute(
    input: RequestChangesPullRequestInput,
    ctx: PipelineExecutionContext,
  ): Promise<string> {
    const pr = prFrom(ctx)
    const payload = JSON.stringify({
      commit_id: pr.sha,
      event: 'REQUEST_CHANGES',
      body: `${input.body.trim()}\n\n${APPROVAL_MARKER}`,
    })
    try {
      const review = await this.client.requestJson<{ html_url?: string }>(
        `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
        { method: 'POST', body: payload },
      )
      return `PR #${pr.number}: cambios pedidos sobre ${pr.sha.slice(0, 7)}${
        review.html_url ? `: ${review.html_url}` : ''
      }`
    } catch (err) {
      if (!OWN_PR_CHANGES.test(err instanceof Error ? err.message : String(err))) throw err
      return `PR #${pr.number} sin cambios pedidos: lo abrió la misma App y GitHub no deja pedir cambios en un PR propio`
    }
  }
}

export const DismissPullRequestApprovalInput = z.strictObject({
  message: z
    .string()
    .min(1)
    .default('El PR volvió a revisión: el veredicto de ia-flow se retira hasta el próximo gate.')
    .describe('El motivo que GitHub muestra en el review retirado'),
})
export type DismissPullRequestApprovalInput = z.infer<typeof DismissPullRequestApprovalInput>

/**
 * Retira los veredictos de ia-flow (los reviews con `APPROVAL_MARKER`: aprobaciones y cambios
 * pedidos) que siguen vigentes en el PR del evento. Corre al EMPEZAR un gate: un commit nuevo no
 * invalida una aprobación salvo que el repo tenga "dismiss stale approvals", el PR no puede quedar
 * aprobado mientras se re-revisa, y un pedido de cambios viejo no puede seguir trabándolo.
 */
export class DismissPullRequestApprovalAction extends Action<
  typeof DismissPullRequestApprovalInput
> {
  readonly description =
    'Retira los veredictos de ia-flow (aprobación o cambios pedidos) que siguen vigentes en el PR.'
  readonly input = DismissPullRequestApprovalInput

  constructor(private readonly client: GithubClient) {
    super({ id: 'dismiss_pull_request_approval' })
  }

  async execute(
    input: DismissPullRequestApprovalInput,
    ctx: PipelineExecutionContext,
  ): Promise<string> {
    const pr = prFrom(ctx)
    const reviews = `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`
    const list = await this.client.requestJson<
      Array<{ id: number; state: string; body?: string | null }>
    >(`${reviews}?per_page=100`)
    const ours = list.filter((r) => VERDICTS.has(r.state) && r.body?.includes(APPROVAL_MARKER))
    for (const r of ours) {
      await this.client.requestJson(`${reviews}/${r.id}/dismissals`, {
        method: 'PUT',
        body: JSON.stringify({ message: input.message, event: 'DISMISS' }),
      })
    }
    return ours.length
      ? `PR #${pr.number}: retiré ${ours.length} veredicto(s) de ia-flow`
      : `PR #${pr.number}: sin veredictos de ia-flow vigentes`
  }
}
