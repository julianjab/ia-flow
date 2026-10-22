/**
 * El merge de un PR que deja en conflicto al PR abierto de un hermano de la misma épica
 * (subscriptions#1993): GitHub no manda ningún evento cuando un PR pasa a `DIRTY`, así que el
 * conflicto se mira acá, al llegar el merge, y se publica `issue.pr_conflict` sobre cada hermano
 * que quedó en conflicto. Sólo los del mismo repo y contra la misma base que el mergeado: un PR de
 * otro repo, o apilado sobre otra rama, no recibió ese merge.
 *
 * Un webhook repetido (un reintento de GitHub, un redelivery) no vuelve a avisar: lo ya avisado por
 * (PR mergeado, hermano) queda en `announced`.
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

export interface Mergeability {
  mergeable: boolean | null
  /** `mergeable_state`: `dirty` es conflicto. */
  state?: string
  /** La branch base del PR. */
  base?: string
}

/** Lo que necesita de `resolve_task`: leer la épica y sus hijos, sus PRs y publicar. */
export interface SiblingPort {
  /** Los issues que cierra el PR mergeado (de este catálogo). */
  closingIssues(owner: string, repo: string, pr: number): Promise<IssueRef[]>
  parentOf(owner: string, repo: string, number: number): Promise<IssueRef | undefined>
  /** Los sub-issues ABIERTOS del padre, de este catálogo. */
  openChildren(parent: IssueRef): Promise<IssueRef[]>
  openPullOf(task: IssueRef): Promise<number | undefined>
  mergeability(owner: string, repo: string, pr: number): Promise<Mergeability>
  publish(
    ctx: PipelineExecutionContext,
    task: IssueRef & { pr: number },
    fields: EventFields,
  ): Promise<DomainEvent<unknown> | { skip: string }>
  /** Lo ya avisado (o por avisar) por (PR mergeado, hermano): el mismo merge no avisa dos veces. */
  announced: { has(key: string): boolean; add(key: string): void; delete(key: string): void }
  sleep?: (ms: number) => Promise<void>
}

/** Cuánto se recuerda un aviso de conflicto ya publicado: más que cualquier redelivery de GitHub. */
const ANNOUNCED_TTL_MS = 24 * 3_600_000

/** Lo ya avisado (`issue.pr_conflict`), con cuándo: lo viejo se olvida al anotar algo nuevo. */
export class Announced {
  private readonly at = new Map<string, number>()

  has(key: string): boolean {
    const at = this.at.get(key)
    return at !== undefined && Date.now() - at < ANNOUNCED_TTL_MS
  }

  add(key: string): void {
    const now = Date.now()
    for (const [old, at] of this.at) if (now - at >= ANNOUNCED_TTL_MS) this.at.delete(old)
    this.at.set(key, now)
  }

  delete(key: string): void {
    this.at.delete(key)
  }
}

const refOf = (issue: IssueRef) => `${issue.owner}/${issue.repo}#${issue.number}`
const keyOf = (issue: IssueRef) => refOf(issue).toLowerCase()
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Lo que GitHub dice del PR una vez que terminó de calcularlo (o lo último, si no terminó). */
async function settled(port: SiblingPort, issue: IssueRef, pr: number): Promise<Mergeability> {
  let last: Mergeability = { mergeable: null }
  for (let attempt = 0; attempt < MERGEABLE_ATTEMPTS; attempt++) {
    if (attempt > 0) await (port.sleep ?? wait)(MERGEABLE_DELAY_MS)
    last = await port.mergeability(issue.owner, issue.repo, pr)
    if (last.mergeable !== null) return last
  }
  return last
}

/** El PR del hermano, si quedó en conflicto contra `base` (o por qué no se publica nada). */
async function conflicted(
  port: SiblingPort,
  sibling: IssueRef,
  base: string | undefined,
): Promise<{ pr: number } | { skip: string }> {
  const pr = await port.openPullOf(sibling)
  if (pr === undefined) return { skip: `${refOf(sibling)} no tiene PR abierto` }
  const found = await settled(port, sibling, pr)
  if (base && found.base && found.base !== base) {
    return { skip: `el PR #${pr} de ${refOf(sibling)} es contra ${found.base}, no contra ${base}` }
  }
  if (found.mergeable === null) {
    return { skip: `GitHub no terminó de calcular si el PR #${pr} se puede mergear` }
  }
  if (found.mergeable || found.state !== 'dirty') {
    return { skip: `el PR #${pr} de ${refOf(sibling)} sigue sin conflictos` }
  }
  return { pr }
}

/** Los hermanos de cada hijo cerrado (sin repetir), con el hijo y la épica de cada uno. */
async function siblingsOf(
  port: SiblingPort,
  closed: IssueRef[],
  repo: string,
): Promise<{
  found: Array<{ sibling: IssueRef; child: IssueRef; epic: IssueRef }>
  skipped: string[]
}> {
  const skipped: string[] = []
  const found = new Map<string, { sibling: IssueRef; child: IssueRef; epic: IssueRef }>()
  const closedKeys = new Set(closed.map(keyOf))
  const parents = await Promise.all(
    closed.map(async (child) => ({
      child,
      epic: await port.parentOf(child.owner, child.repo, child.number),
    })),
  )
  for (const { child, epic } of parents) {
    if (!epic) {
      skipped.push(`${refOf(child)} no es sub-issue de nada`)
      continue
    }
    const siblings = (await port.openChildren(epic)).filter(
      (sibling) =>
        !closedKeys.has(keyOf(sibling)) &&
        `${sibling.owner}/${sibling.repo}`.toLowerCase() === repo.toLowerCase(),
    )
    if (siblings.length === 0)
      skipped.push(`${refOf(epic)} no tiene otros hijos abiertos en ${repo}`)
    for (const sibling of siblings) {
      if (!found.has(keyOf(sibling))) found.set(keyOf(sibling), { sibling, child, epic })
    }
  }
  return { found: [...found.values()], skipped }
}

/** `issue.pr_conflict` sobre cada hermano de la épica cuyo PR abierto quedó en conflicto con la
 *  base después del merge de `merged` (contra `base`, la branch en la que entró). */
export async function notifySiblingConflicts(
  port: SiblingPort,
  ctx: PipelineExecutionContext,
  merged: { owner: string; repo: string; pr: number; base?: string },
): Promise<Resolved> {
  const closed = await port.closingIssues(merged.owner, merged.repo, merged.pr)
  if (closed.length === 0) return { skipped: `PR #${merged.pr} no cierra ningún issue` }
  const mergedPr = `${merged.owner}/${merged.repo}#${merged.pr}`
  const { found, skipped } = await siblingsOf(port, closed, `${merged.owner}/${merged.repo}`)
  // En paralelo: cada uno puede esperar a que GitHub recalcule su `mergeable`. Uno que falla
  // (un 404 de su PR) no tira a los demás.
  const results = await Promise.all(
    found.map(async ({ sibling, child, epic }) => {
      // Se reserva ANTES de esperar a GitHub: dos entregas del mismo merge casi juntas (un
      // reintento, un redelivery) no pasan las dos. Si no se publica, se suelta.
      const key = `${mergedPr.toLowerCase()}→${keyOf(sibling)}`
      if (port.announced.has(key)) {
        return { skip: `ya avisé a ${refOf(sibling)} del merge de ${mergedPr}` }
      }
      port.announced.add(key)
      let result: DomainEvent<unknown> | { skip: string }
      try {
        const hit = await conflicted(port, sibling, merged.base)
        result =
          'skip' in hit
            ? hit
            : await port.publish(
                ctx,
                { ...sibling, pr: hit.pr },
                {
                  emit: PR_CONFLICT,
                  extra: { mergedPr, mergedChild: refOf(child), epic: refOf(epic) },
                },
              )
      } catch (err) {
        result = { skip: `no pude mirar ${refOf(sibling)}: ${errorText(err)}` }
      }
      // Sólo queda anotado lo publicado: un hermano sin conflicto todavía, o que el `when` del
      // intake descartó (trabado), se puede avisar en el próximo merge.
      if ('skip' in result) port.announced.delete(key)
      return result
    }),
  )
  const emitted: string[] = []
  for (const result of results) {
    if ('skip' in result) skipped.push(result.skip)
    else emitted.push(String(result.scope?.issue))
  }
  return emitted.length > 0 ? { emitted } : { skipped: skipped.join(' · ') || 'nada en conflicto' }
}
