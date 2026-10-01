import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { issuePath, repoPath } from '../shared.js'
import {
  type BranchResolver,
  branchFromPayload,
  type IssueRef,
  type IssueRefResolver,
  issueFromPayload,
} from './issueRef.js'

/** Nada que decida el modelo: el issue y la rama salen del evento. */
export const EnsurePullRequestInput = z.strictObject({})
export type EnsurePullRequestInput = z.infer<typeof EnsurePullRequestInput>

export interface EnsurePullRequestActionOptions {
  client: GithubClient
  issue?: IssueRefResolver
  branch?: BranchResolver
  id?: string
}

interface PullRequestShape {
  number: number
  html_url: string
  body: string | null
  state?: 'open' | 'closed'
  merged_at?: string | null
}

/** `Closes #n` y sus sinónimos, también en la forma `owner/repo#n` — lo que GitHub reconoce para
 *  vincular el PR al issue y cerrarlo al mergear. */
export function closesIssue(body: string, issue: IssueRef): boolean {
  const ref = `(?:${escapeRegExp(issue.owner)}/${escapeRegExp(issue.repo)})?#${issue.number}`
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+${ref}\\b`, 'i').test(body)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Garantiza que la rama de la task tenga un PR abierto contra la default branch, y que ese PR
 * cierre el issue (`Closes #n`). El modelo sigue escribiendo el PR — título y descripción son
 * suyos —, esto cubre lo que no puede depender de él: que el PR exista y quede vinculado al issue.
 *
 * - PR abierto sin `Closes #n`: se lo agrega al final del body, sin tocar lo demás.
 * - PR abierto que ya lo cierra: no hace nada.
 * - Sin PR abierto pero con uno mergeado o cerrado para la rama: tira. Abrir otro (o reabrir
 *   uno cerrado a mano) es decisión humana, no del engine.
 * - Sin ningún PR: lo abre, con el título del issue y `Closes #n` de cuerpo — sólo si la rama
 *   tiene commits propios por delante de la base. Que la rama exista no alcanza: `link_branch`
 *   la crea al arrancar apuntando a la base, así que existe aunque no se haya publicado nada.
 */
export class EnsurePullRequestAction extends Action<typeof EnsurePullRequestInput> {
  readonly description =
    'Asegura un PR abierto desde la rama de la task que cierre el issue (Closes #n).'
  readonly input = EnsurePullRequestInput
  private readonly client: GithubClient
  private readonly resolveIssue: IssueRefResolver
  private readonly resolveBranch: BranchResolver

  constructor(options: EnsurePullRequestActionOptions) {
    super({ id: options.id ?? 'ensure_pull_request' })
    this.client = options.client
    this.resolveIssue = options.issue ?? issueFromPayload
    this.resolveBranch = options.branch ?? branchFromPayload
  }

  async execute(_input: EnsurePullRequestInput, ctx: PipelineExecutionContext): Promise<string> {
    const issue = this.resolveIssue(ctx)
    const branch = this.resolveBranch(ctx)
    const repo = (suffix = '') => repoPath(issue.owner, issue.repo, suffix)
    const closing = `Closes #${issue.number}`

    const head = encodeURIComponent(`${issue.owner}:${branch}`)
    // `state=all`: una rama que ya tuvo un PR mergeado o cerrado no puede terminar con otro nuevo.
    const pulls = await this.client.requestJson<PullRequestShape[]>(
      repo(`/pulls?state=all&head=${head}`),
    )
    const open = pulls.find((pr) => pr.state !== 'closed')

    if (open) {
      const body = open.body ?? ''
      if (closesIssue(body, issue)) {
        return `PR #${open.number} ya cierra #${issue.number}: ${open.html_url}`
      }
      await this.client.requestJson(repo(`/pulls/${open.number}`), {
        method: 'PATCH',
        body: JSON.stringify({ body: body.trim() ? `${body.trimEnd()}\n\n${closing}` : closing }),
      })
      return `PR #${open.number}: agregado "${closing}" — ${open.html_url}`
    }

    const previous = pulls[0]
    if (previous) {
      const how = previous.merged_at ? 'se mergeó' : 'se cerró sin mergear'
      throw new Error(
        `ensure_pull_request: el PR #${previous.number} de ${branch} ${how} — abrir otro es decisión humana (${previous.html_url})`,
      )
    }

    const [repository, issueData] = await Promise.all([
      this.client.requestJson<{ default_branch: string }>(repo()),
      this.client.requestJson<{ title: string }>(issuePath(issue.owner, issue.repo, issue.number)),
    ])
    const base = repository.default_branch
    const compare = await this.client.request(
      repo(`/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`),
    )
    if (compare.status === 404) {
      throw new Error(
        `ensure_pull_request: la rama ${branch} no está en ${issue.owner}/${issue.repo} — no se publicó nada, no hay PR que abrir`,
      )
    }
    if (!compare.ok) {
      throw new Error(
        `ensure_pull_request: no se pudo comparar ${branch} con ${base} → ${compare.status}`,
      )
    }
    const { ahead_by: ahead } = (await compare.json()) as { ahead_by: number }
    if (!(ahead > 0)) {
      throw new Error(
        `ensure_pull_request: ${branch} no tiene commits por delante de ${base} — no se publicó nada, no hay PR que abrir`,
      )
    }
    const created = await this.client.requestJson<PullRequestShape>(repo('/pulls'), {
      method: 'POST',
      body: JSON.stringify({
        title: issueData.title,
        head: branch,
        base,
        body: closing,
      }),
    })
    return `PR #${created.number} abierto desde ${branch}: ${created.html_url}`
  }
}
