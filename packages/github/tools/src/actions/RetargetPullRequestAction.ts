import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { repoPath } from '../shared.js'
import {
  assertSafeBranch,
  type IssueRefResolver,
  issueFromPayload,
  type PrNumberResolver,
  prFromPayload,
} from './issueRef.js'

/** Nada que decida el modelo: el PR y las ramas salen del evento. */
export const RetargetPullRequestInput = z.strictObject({})
export type RetargetPullRequestInput = z.infer<typeof RetargetPullRequestInput>

export interface RetargetPullRequestActionOptions {
  client: GithubClient
  issue?: IssueRefResolver
  pr?: PrNumberResolver
  id?: string
}

/**
 * Un PR apilado cuya base acaba de mergearse (`issue.base_merged`: `from` es la rama del
 * prerrequisito y `to` la rama en la que entró): lo apunta a `to`. GitHub lo hace solo cuando el
 * repo borra la rama mergeada, pero no siempre la borra; si ya lo hizo, o una persona lo apuntó a
 * otra rama, no toca nada.
 */
export class RetargetPullRequestAction extends Action<typeof RetargetPullRequestInput> {
  readonly description = 'Apunta el PR apilado de la task a la rama en la que entró su base.'
  readonly input = RetargetPullRequestInput
  private readonly client: GithubClient
  private readonly resolveIssue: IssueRefResolver
  private readonly resolvePr: PrNumberResolver

  constructor(options: RetargetPullRequestActionOptions) {
    super({ id: options.id ?? 'retarget_pr' })
    this.client = options.client
    this.resolveIssue = options.issue ?? issueFromPayload
    this.resolvePr = options.pr ?? prFromPayload
  }

  async execute(_input: RetargetPullRequestInput, ctx: PipelineExecutionContext): Promise<string> {
    const issue = this.resolveIssue(ctx)
    const number = this.resolvePr(ctx)
    if (number === undefined) throw new Error('retarget_pr: el evento no trae el PR de la task')
    const { from, to } = (ctx.event.payload ?? {}) as { from?: unknown; to?: unknown }
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new Error('retarget_pr: el evento no trae from/to (issue.base_merged)')
    }
    const path = repoPath(issue.owner, issue.repo, `/pulls/${number}`)
    const pr = await this.client.requestJson<{ base?: { ref?: string } }>(path)
    const base = pr.base?.ref
    if (base === to) return `PR #${number} ya apunta a ${to}`
    if (base !== from) return `PR #${number} apunta a ${base ?? '?'}, no a ${from}: no lo toco`
    await this.client.requestJson(path, {
      method: 'PATCH',
      body: JSON.stringify({ base: assertSafeBranch(to) }),
    })
    return `PR #${number}: base ${from} → ${to}`
  }
}
