/**
 * Lo que un sub-issue le avisa a su épica: un evento publicado sobre el PADRE, no sobre el hijo
 * (`issue.child_closed`, `issue.child_status_changed`). Cae en la cola de la épica, detrás de lo
 * que tenga corriendo: el hijo no la interrumpe.
 */
import type { DomainEvent, PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { EventFields, Location } from '@ia-flow/github-webhook'

export interface IssueRef {
  owner: string
  repo: string
  number: number
}

/** Lo que hizo con un webhook, para la traza y el log. */
export type Resolved = { emitted: string[] } | { skipped: string }

/** Lo que necesita de `resolve_task`: leer el padre, saber qué repos son suyos y publicar. */
export interface ParentPort {
  projectId: string
  parentOf(owner: string, repo: string, number: number): Promise<IssueRef | undefined>
  inCatalog(owner: string, repo: string): boolean
  publish(
    ctx: PipelineExecutionContext,
    task: IssueRef,
    fields: EventFields,
  ): Promise<DomainEvent<unknown> | { skip: string }>
}

/** Publica `emit` sobre el padre de `child` si el padre es de este proyecto (su catálogo, su board
 *  y el `when` del intake, que aplica `publish`). El hijo puede ser de otro repo. */
export async function notifyParent(
  port: ParentPort,
  ctx: PipelineExecutionContext,
  child: IssueRef,
  emit: string,
  extra: Record<string, unknown>,
): Promise<Resolved> {
  const ref = `${child.owner}/${child.repo}#${child.number}`
  const parent = await port.parentOf(child.owner, child.repo, child.number)
  if (!parent) return { skipped: `${ref} no es sub-issue de nada` }
  if (!port.inCatalog(parent.owner, parent.repo)) {
    return { skipped: `el padre de ${ref} no es del catálogo de ${port.projectId}` }
  }
  const childUrl = `https://github.com/${child.owner}/${child.repo}/issues/${child.number}`
  const published = await port.publish(ctx, parent, {
    emit,
    extra: { ...extra, child: ref, childUrl },
  })
  return 'skip' in published
    ? { skipped: published.skip }
    : { emitted: [String(published.scope?.issue)] }
}

const CHILD_STATUS_CHANGED = 'issue.child_status_changed'
const CHILD_LABELED = 'issue.child_labeled'

/** Un webhook ya ubicado que no se saltó: un item del board o un issue de un repo. */
export type ChildLocation = Exclude<Location, { skip: string }>

/** De la ubicación de un webhook, el hijo: el issue de un item o el de un repo (`resolve_task`). */
type ChildOf = (at: ChildLocation) => Promise<IssueRef | { skipped: string }>

/** `issue.child_status_changed` sobre el padre del issue que cambió de columna. */
export async function statusToParent(
  port: ParentPort,
  ctx: PipelineExecutionContext,
  location: Location,
  childOf: ChildOf,
): Promise<Resolved> {
  if ('skip' in location) return { skipped: location.skip }
  if (location.emit !== 'issue.status_changed') {
    return { skipped: `${location.emit} no es un cambio de columna` }
  }
  const child = await childOf(location)
  if ('skipped' in child) return child
  return notifyParent(port, ctx, child, CHILD_STATUS_CHANGED, location.extra)
}

/** `issue.child_labeled` sobre el padre del issue que recibió uno de `labels`. */
export async function labelToParent(
  port: ParentPort,
  ctx: PipelineExecutionContext,
  location: Location,
  childOf: ChildOf,
  labels: string[],
): Promise<Resolved> {
  if ('skip' in location) return { skipped: location.skip }
  const label = location.extra.label
  if (location.emit !== 'issue.labeled' || typeof label !== 'string') {
    return { skipped: `${location.emit} no es un label nuevo` }
  }
  if (!labels.some((wanted) => wanted.toLowerCase() === label.toLowerCase())) {
    return { skipped: `el label ${label} no se avisa al padre` }
  }
  const child = await childOf(location)
  if ('skipped' in child) return child
  return notifyParent(port, ctx, child, CHILD_LABELED, { label })
}
