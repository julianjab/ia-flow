/**
 * Lo que el intake lee para una task que avanza sobre prerrequisitos construidos (`stacking` en
 * `project.yaml`): sobre qué rama se apila al publicar su evento, y si su PR estaba apilado sobre
 * el que se acaba de mergear.
 */
import type { GithubTaskReader, RawTaskContext, Stack } from '@ia-flow/github-tools'
import { stackOf } from '@ia-flow/github-tools'

type StackReader = Pick<GithubTaskReader, 'stackBlockers' | 'openPullRequest' | 'contains'>

interface IssueRef {
  owner: string
  repo: string
  number: number
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Con el label de `stacking` en la task: qué blockers la siguen frenando y sobre qué rama se apila.
 *  Sin el label, `undefined`: frena cualquier blocker abierto. */
export async function taskStack(
  reader: StackReader,
  label: string | undefined,
  task: IssueRef,
  context: Pick<RawTaskContext, 'issue' | 'blockers'>,
  closedBlocker: string | undefined,
): Promise<Stack | undefined> {
  const labels = context.issue.labels.map((l) => (typeof l === 'string' ? l : l.name))
  if (!label || !labels.includes(label)) return undefined
  const open = context.blockers.filter((b) => b.html_url !== closedBlocker)
  return stackOf(task, await reader.stackBlockers(open))
}

/** El PR abierto de `dependent` si estaba apilado sobre la rama del PR mergeado: apunta a ella, o
 *  ya la trae (GitHub lo reapunta solo cuando borra la rama mergeada). Sólo en el mismo repo. */
export async function stackedOn(
  reader: StackReader,
  merged: { owner: string; repo: string; head: string; headSha: string; base: string },
  dependent: IssueRef,
): Promise<number | undefined> {
  if (!same(dependent.owner, merged.owner) || !same(dependent.repo, merged.repo)) return undefined
  const pr = await reader.openPullRequest(dependent)
  if (!pr) return undefined
  if (pr.baseRef === merged.head) return pr.number
  if (pr.baseRef !== merged.base || !merged.headSha) return undefined
  const carries = await reader.contains(merged.owner, merged.repo, merged.headSha, pr.headRef)
  return carries ? pr.number : undefined
}
