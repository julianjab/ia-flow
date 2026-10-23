/**
 * Lo que el merge de un PR le avisa a las tasks que su issue bloqueaba (`mark_blocked_by`):
 * `issue.unblocked` a las que quedaron sin otro blocker abierto, o `issue.base_merged` a la que tenía
 * el PR apilado sobre la rama mergeada (`stacking`) —tenga o no otros blockers—: su PR tiene que
 * pasar a la rama en la que entró y traerla.
 */
import type { DomainEvent, PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { EventFields } from '@ia-flow/github-webhook'
import type { IssueRef, Resolved } from './parentEvents.js'

const UNBLOCKED = 'issue.unblocked'
/** Se mergeó el prerrequisito sobre cuya rama estaba apilado el PR de la task. */
const BASE_MERGED = 'issue.base_merged'

/** El PR mergeado, con su rama y la rama en la que entró. */
export interface MergedPr {
  owner: string
  repo: string
  pr: number
  head: string
  headSha: string
  base: string
}

/** Lo que necesita de `resolve_task`. */
export interface UnblockPort {
  /** Los issues del catálogo que cierra el PR. */
  closingIssues(merged: MergedPr): Promise<IssueRef[]>
  /** Los issues del catálogo que `blocker` bloquea. */
  dependents(blocker: IssueRef): Promise<IssueRef[]>
  /** El PR abierto de `dependent` si estaba apilado sobre el mergeado. Sin `stacking`, ausente. */
  stackedOn?(merged: MergedPr, dependent: IssueRef): Promise<number | undefined>
  publish(
    ctx: PipelineExecutionContext,
    task: IssueRef & { pr?: number },
    fields: EventFields,
    options: { closedBlocker: string; onlyIfUnblocked?: boolean },
  ): Promise<DomainEvent<unknown> | { skip: string }>
}

/** El recién cerrado no cuenta como blocker: el webhook del merge puede llegar antes que su cierre. */
export async function notifyDependents(
  port: UnblockPort,
  ctx: PipelineExecutionContext,
  merged: MergedPr,
): Promise<Resolved> {
  const blockers = await port.closingIssues(merged)
  if (blockers.length === 0) return { skipped: `PR #${merged.pr} no cierra ningún issue` }
  const emitted: string[] = []
  for (const blocker of blockers) {
    const closedBlocker = `https://github.com/${blocker.owner}/${blocker.repo}/issues/${blocker.number}`
    for (const dependent of await port.dependents(blocker)) {
      const stacked = await port.stackedOn?.(merged, dependent)
      const published =
        stacked !== undefined
          ? await port.publish(
              ctx,
              { ...dependent, pr: stacked },
              {
                emit: BASE_MERGED,
                extra: {
                  from: merged.head,
                  to: merged.base,
                  mergedPr: `${merged.owner}/${merged.repo}#${merged.pr}`,
                },
              },
              { closedBlocker },
            )
          : await port.publish(
              ctx,
              dependent,
              { emit: UNBLOCKED, extra: {} },
              { closedBlocker, onlyIfUnblocked: true },
            )
      if (!('skip' in published)) emitted.push(String(published.scope?.issue))
    }
  }
  return emitted.length > 0
    ? { emitted }
    : { skipped: `PR #${merged.pr} no deja ninguna task sin prerrequisitos` }
}
