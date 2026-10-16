/**
 * Quién puede tocar una tarea desde la bandeja: la ref que se pide y el permiso de escritura de la
 * persona en su repo, preguntándole a GitHub con SU token.
 */
import type { GithubClient } from '@ia-flow/github-api'
import { TaskActionError } from './TaskActionError.js'

export interface IssueTarget {
  owner: string
  repo: string
  number: number
}

export function parseRef(ref: string): IssueTarget {
  const match = ref.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/)
  if (!match) throw new TaskActionError(`"${ref}" no es owner/repo#n`, 400)
  return { owner: match[1] as string, repo: match[2] as string, number: Number(match[3]) }
}

/**
 * Que quien pide la acción pueda escribir en el repo de la tarea. Sin esto, relanzar o parar (que
 * no tocan GitHub) los podría pedir cualquier cuenta: el runner los hace con su propia identidad.
 */
export async function assertCanPush(
  client: GithubClient,
  target: Pick<IssueTarget, 'owner' | 'repo'>,
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
