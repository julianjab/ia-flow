/**
 * Prerrequisitos refinados (`refinedStatuses` de `resolve_task`): una task puede refinarse cuando
 * cada prerrequisito abierto ya tiene su PRD (`item.blockersRefined`), sin esperar a que se mergee.
 * `item.blocked` no sirve para eso dentro de una épica: los hijos no se construyen hasta que la
 * épica pasa a Build, y la épica no pasa hasta que todos sus hijos están refinados.
 *
 * Cuando un prerrequisito llega a una columna refinada, `issue.blockers_refined` despierta a las
 * tasks que bloquea y que ya no esperan a ningún otro.
 */
import type { DomainEvent, PipelineExecutionContext } from '@ia-flow/agent-engine'
import { issueOfUrl } from '@ia-flow/github-tools'
import type { EventFields, Location } from '@ia-flow/github-webhook'
import type { IssueRef, Resolved } from './parentEvents.js'

const BLOCKERS_REFINED = 'issue.blockers_refined'

const refText = (ref: IssueRef) => `${ref.owner}/${ref.repo}#${ref.number}`
const sameRef = (a: IssueRef, b: IssueRef) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.repo.toLowerCase() === b.repo.toLowerCase() &&
  a.number === b.number

/** Si `status` es una de las columnas refinadas (sin distinguir mayúsculas). */
export function isRefinedStatus(status: string | undefined, refined: readonly string[]): boolean {
  if (!status) return false
  const wanted = status.toLowerCase()
  return refined.some((name) => name.toLowerCase() === wanted)
}

/** Lo que el cálculo lee de GitHub y del board. */
export interface RefinedBlockersPort {
  /** El status de la card del issue en el board del proyecto; sin card, `undefined`. */
  statusOf(ref: IssueRef): Promise<string | undefined>
  /** Los issues que `ref` bloquea: un blocker que también espera a la task es un ciclo. */
  dependents(ref: IssueRef): Promise<IssueRef[]>
}

export interface BlockersRefined {
  /** Ningún prerrequisito abierto sigue sin refinar (fuera de los ciclos). */
  refined: boolean
  /** Los que todavía no llegaron a una columna refinada (`o/r#n`, o la URL si no es de un issue). */
  waiting: string[]
  /** Los que bloquean a la task y a la vez esperan por ella: no cuentan, para no trabarse. */
  cycles: string[]
}

/**
 * Si los prerrequisitos abiertos de `task` ya están refinados. `refinedNow` es el que se acaba de
 * mover a una columna refinada: cuenta como refinado aunque el board todavía no lo refleje. Un
 * blocker sin card en el board no está refinado (nadie le va a escribir el PRD): espera a que cierre.
 */
export async function blockersRefined(
  port: RefinedBlockersPort,
  task: IssueRef,
  openBlockerUrls: readonly string[],
  refined: readonly string[],
  refinedNow?: IssueRef,
): Promise<BlockersRefined> {
  if (openBlockerUrls.length === 0) return { refined: true, waiting: [], cycles: [] }
  const blockers = openBlockerUrls.map((url) => ({ url, ref: issueOfUrl(url) }))
  const dependents = blockers.some((b) => b.ref) ? await port.dependents(task) : []
  const waiting: string[] = []
  const cycles: string[] = []
  for (const { url, ref } of blockers) {
    if (!ref) {
      waiting.push(url)
      continue
    }
    if (refinedNow && sameRef(ref, refinedNow)) continue
    if (dependents.some((dependent) => sameRef(dependent, ref))) {
      cycles.push(refText(ref))
      continue
    }
    if (!isRefinedStatus(await port.statusOf(ref), refined)) waiting.push(refText(ref))
  }
  return { refined: waiting.length === 0, waiting, cycles }
}

/** Lo que el aviso necesita de `resolve_task`. */
export interface NotifyRefinedPort {
  /** Los issues del catálogo que `blocker` bloquea. */
  dependents(blocker: IssueRef): Promise<IssueRef[]>
  publish(
    ctx: PipelineExecutionContext,
    task: IssueRef,
    fields: EventFields,
    options: { refinedBlocker: IssueRef; onlyIfBlockersRefined: true },
  ): Promise<DomainEvent<unknown> | { skip: string }>
}

/** Un webhook ya ubicado que no se saltó: un item del board o un issue de un repo. */
type Located = Exclude<Location, { skip: string }>

/**
 * `issue.blockers_refined` a cada task que `moved` bloquea, si `moved` acaba de llegar a una
 * columna refinada y la task ya no espera a ningún otro prerrequisito sin refinar (`publish` lo
 * comprueba con `onlyIfBlockersRefined`).
 */
export async function notifyBlockersRefined(
  port: NotifyRefinedPort,
  ctx: PipelineExecutionContext,
  location: Location,
  movedOf: (at: Located) => Promise<IssueRef | { skipped: string }>,
  refined: readonly string[],
): Promise<Resolved> {
  if ('skip' in location) return { skipped: location.skip }
  if (location.emit !== 'issue.status_changed') {
    return { skipped: `${location.emit} no es un cambio de columna` }
  }
  const to = typeof location.extra.to === 'string' ? location.extra.to : undefined
  if (!isRefinedStatus(to, refined)) {
    return { skipped: `${to ?? 'la columna nueva'} no es una columna refinada` }
  }
  const moved = await movedOf(location)
  if ('skipped' in moved) return moved
  const emitted: string[] = []
  for (const dependent of await port.dependents(moved)) {
    const published = await port.publish(
      ctx,
      dependent,
      { emit: BLOCKERS_REFINED, extra: { blocker: refText(moved), to } },
      { refinedBlocker: moved, onlyIfBlockersRefined: true },
    )
    if (!('skip' in published)) emitted.push(String(published.scope?.issue))
  }
  return emitted.length > 0
    ? { emitted }
    : { skipped: `${refText(moved)} no deja ninguna task con sus prerrequisitos refinados` }
}
