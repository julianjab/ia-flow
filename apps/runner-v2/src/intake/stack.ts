/**
 * Lo que el intake lee para una task que avanza sobre prerrequisitos construidos (`stacking` en
 * `project.yaml`): sobre qué rama se apila al publicar su evento, y si su PR estaba apilado sobre
 * el que se acaba de mergear.
 */
import type { GithubTaskReader, RawTaskContext, Stack } from '@ia-flow/github-tools'
import { issueOfUrl, stackBlockers, stackOf } from '@ia-flow/github-tools'

type StackReader = Pick<GithubTaskReader, 'openPullRequest' | 'contains' | 'firstCommit'>

interface IssueRef {
  owner: string
  repo: string
  number: number
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const refText = (ref: IssueRef) => `${ref.owner}/${ref.repo}#${ref.number}`

/** `https://github.com/o/r/issues/n` → `o/r#n`, la forma de `Stack.pending`; una URL que no es la
 *  de un issue queda tal cual (y así sigue pendiente: nadie la construye). */
export function refOfUrl(url: string): string {
  const ref = issueOfUrl(url)
  return ref ? refText(ref) : url
}

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
  const open = context.blockers.filter((b) => b.state === 'open' && b.html_url !== closedBlocker)
  const stack = stackOf(task, await stackBlockers(reader, open))
  const unknown = open.filter((b) => !issueOfUrl(b.html_url)).map((b) => b.html_url)
  return unknown.length > 0 ? { ...stack, pending: [...stack.pending, ...unknown] } : stack
}

/** El PR abierto de `dependent` si estaba apilado sobre la rama del PR mergeado: apunta a ella, o
 *  ya la trae (GitHub lo reapunta solo cuando borra la rama mergeada). "La trae" es tener el primer
 *  commit del PR mergeado: la punta no alcanza, porque el prerrequisito pudo recibir commits (su
 *  review) después de que la rama del dependiente salió de la suya. Sólo en el mismo repo. Si
 *  GitHub no contesta (la rama del PR ya no está, un fork), no estaba apilado: el merge no deja sin
 *  aviso a los demás dependientes. */
export async function stackedOn(
  reader: StackReader,
  merged: { owner: string; repo: string; pr: number; head: string; base: string },
  dependent: IssueRef,
): Promise<number | undefined> {
  if (!same(dependent.owner, merged.owner) || !same(dependent.repo, merged.repo)) return undefined
  try {
    const pr = await reader.openPullRequest(dependent)
    if (!pr) return undefined
    if (pr.baseRef === merged.head) return pr.number
    if (pr.baseRef !== merged.base) return undefined
    const first = await reader.firstCommit(merged.owner, merged.repo, merged.pr)
    if (!first) return undefined
    const carries = await reader.contains(merged.owner, merged.repo, first, pr.headRef)
    return carries ? pr.number : undefined
  } catch {
    return undefined
  }
}
