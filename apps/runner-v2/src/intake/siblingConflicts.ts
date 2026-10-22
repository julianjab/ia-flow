/**
 * El merge de un PR que deja en conflicto al PR abierto de un hermano de la misma épica
 * (subscriptions#1993): GitHub no manda ningún evento cuando un PR pasa a `DIRTY`, así que el
 * conflicto se mira acá, al llegar el merge, y se publica `issue.pr_conflict` sobre cada hermano
 * que quedó en conflicto. Sólo los del mismo repo: un PR de otro repo no comparte la base.
 */
import type { DomainEvent, PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { EventFields } from '@ia-flow/github-webhook'
import type { IssueRef, Resolved } from './parentEvents.js'

export const PR_CONFLICT = 'issue.pr_conflict'

/** Cuántas veces se le pregunta a GitHub si el PR se puede mergear, y cuánto se espera entre una
 *  y otra: el `mergeable` de un PR se recalcula después del merge en la base, y mientras tanto es
 *  `null`. ~15 s en total. */
const MERGEABLE_ATTEMPTS = 4
const MERGEABLE_DELAY_MS = 5_000

/** Lo que necesita de `resolve_task`: leer la épica y sus hijos, sus PRs y publicar. */
export interface SiblingPort {
  /** Los issues que cierra el PR mergeado (de este catálogo). */
  closingIssues(owner: string, repo: string, pr: number): Promise<IssueRef[]>
  parentOf(owner: string, repo: string, number: number): Promise<IssueRef | undefined>
  /** Los sub-issues ABIERTOS del padre, de este catálogo. */
  openChildren(parent: IssueRef): Promise<IssueRef[]>
  openPullOf(task: IssueRef): Promise<number | undefined>
  mergeable(owner: string, repo: string, pr: number): Promise<boolean | null>
  publish(
    ctx: PipelineExecutionContext,
    task: IssueRef & { pr: number },
    fields: EventFields,
  ): Promise<DomainEvent<unknown> | { skip: string }>
  sleep?: (ms: number) => Promise<void>
}

const refOf = (issue: IssueRef) => `${issue.owner}/${issue.repo}#${issue.number}`
const sameIssue = (a: IssueRef, b: IssueRef) => refOf(a).toLowerCase() === refOf(b).toLowerCase()
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** `false` si GitHub dice que el PR tiene conflictos; `null` si no terminó de calcularlo. */
async function settledMergeable(
  port: SiblingPort,
  owner: string,
  repo: string,
  pr: number,
): Promise<boolean | null> {
  for (let attempt = 0; attempt < MERGEABLE_ATTEMPTS; attempt++) {
    if (attempt > 0) await (port.sleep ?? wait)(MERGEABLE_DELAY_MS)
    const mergeable = await port.mergeable(owner, repo, pr)
    if (mergeable !== null) return mergeable
  }
  return null
}

/** El hermano y su PR, si quedó en conflicto (o por qué no se publica nada). */
async function conflicted(
  port: SiblingPort,
  sibling: IssueRef,
): Promise<{ pr: number } | { skip: string }> {
  const pr = await port.openPullOf(sibling)
  if (pr === undefined) return { skip: `${refOf(sibling)} no tiene PR abierto` }
  const mergeable = await settledMergeable(port, sibling.owner, sibling.repo, pr)
  if (mergeable === null)
    return { skip: `GitHub no terminó de calcular si el PR #${pr} se puede mergear` }
  return mergeable ? { skip: `el PR #${pr} de ${refOf(sibling)} sigue sin conflictos` } : { pr }
}

/** `issue.pr_conflict` sobre cada hermano de la épica cuyo PR abierto quedó en conflicto con la
 *  base después del merge de `merged`. */
export async function notifySiblingConflicts(
  port: SiblingPort,
  ctx: PipelineExecutionContext,
  merged: { owner: string; repo: string; pr: number },
): Promise<Resolved> {
  const closed = await port.closingIssues(merged.owner, merged.repo, merged.pr)
  if (closed.length === 0) return { skipped: `PR #${merged.pr} no cierra ningún issue` }
  const mergedPr = `${merged.owner}/${merged.repo}#${merged.pr}`
  const skipped: string[] = []
  const emitted: string[] = []
  for (const child of closed) {
    const parent = await port.parentOf(child.owner, child.repo, child.number)
    if (!parent) {
      skipped.push(`${refOf(child)} no es sub-issue de nada`)
      continue
    }
    const siblings = (await port.openChildren(parent)).filter(
      (sibling) =>
        !sameIssue(sibling, child) &&
        `${sibling.owner}/${sibling.repo}`.toLowerCase() ===
          `${merged.owner}/${merged.repo}`.toLowerCase(),
    )
    if (siblings.length === 0)
      skipped.push(`${refOf(parent)} no tiene otros hijos abiertos en ${merged.repo}`)
    // En paralelo: cada uno puede esperar a que GitHub recalcule su `mergeable`.
    const results = await Promise.all(
      siblings.map(async (sibling) => {
        const found = await conflicted(port, sibling)
        if ('skip' in found) return found
        return port.publish(
          ctx,
          { ...sibling, pr: found.pr },
          {
            emit: PR_CONFLICT,
            extra: { mergedPr, mergedChild: refOf(child), epic: refOf(parent) },
          },
        )
      }),
    )
    for (const result of results) {
      if ('skip' in result) skipped.push(result.skip)
      else emitted.push(String(result.scope?.issue))
    }
  }
  return emitted.length > 0 ? { emitted } : { skipped: skipped.join(' · ') || 'nada en conflicto' }
}
