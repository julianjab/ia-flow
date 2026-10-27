/**
 * PRDs que un merge deja viejos (`notifyRelatedMerged` de `resolve_task`): cuando se mergea un PR,
 * cada task del mismo repo que todavía no tiene PR, y cuyo PRD nombra en su zona de impacto un
 * archivo que el PR cambió, recibe `issue.related_merged` con el PR y los archivos en común. Así
 * un PRD refinado antes de ese merge se revisa antes de que el implementer duplique lo que ya está
 * en `main` (lh-seller-v2-frontend#4507, #4504 y #4508 frente a #4502).
 *
 * El cruce es determinístico: la zona de impacto del PRD es una lista de rutas entre las marcas
 * `<!-- ia-flow:prd.zona_de_impacto -->` y su cierre.
 */
import type { DomainEvent, PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { BoardCard } from '@ia-flow/github-tools'
import type { EventFields } from '@ia-flow/github-webhook'
import type { IssueRef, Resolved } from './parentEvents.js'

const RELATED_MERGED = 'issue.related_merged'
const ZONE =
  /<!--\s*ia-flow:prd\.zona_de_impacto\s*-->([\s\S]*?)<!--\s*\/ia-flow:prd\.zona_de_impacto\s*-->/
/** Una ruta entre backticks: sin espacios, con al menos una `/` o una extensión. */
const CODE = /`([^`\s]+)`/g
/** Lo que se le pega a una ruta en un PRD y no es parte de ella: `:12`, `:12-30`, `#L12`. */
const SUFFIX = /(?::\d+(?:[-,]\d+)*|#L\d+(?:-L?\d+)?)$/

/** Las rutas que nombra la zona de impacto del PRD de `body`; sin zona, ninguna. */
export function impactPaths(body: string): string[] {
  const zone = ZONE.exec(body)?.[1]
  if (!zone) return []
  const paths = new Set<string>()
  for (const [, raw] of zone.matchAll(CODE)) {
    const path = (raw ?? '').replace(SUFFIX, '').replace(/^\.\//, '')
    if (path.includes('/') || /\.[a-z0-9]+$/i.test(path)) paths.add(path)
  }
  return [...paths]
}

/** Los archivos de `files` que nombra `impact`: la ruta exacta, o todo lo que está debajo de una
 *  carpeta (`a/b/` o `a/b`). */
export function touched(impact: readonly string[], files: readonly string[]): string[] {
  return files.filter((file) =>
    impact.some((path) => {
      const dir = path.endsWith('/') ? path : `${path}/`
      return file === path || file.startsWith(dir)
    }),
  )
}

/** El PR mergeado. */
export interface MergedRef {
  owner: string
  repo: string
  pr: number
}

/** Lo que el aviso necesita de `resolve_task`. */
export interface RelatedMergedPort {
  /** Las cards abiertas del board del proyecto. */
  cards(): Promise<BoardCard[]>
  /** Los archivos que cambió el PR. */
  pullFiles(merged: MergedRef): Promise<string[]>
  /** Los issues que cierra el PR: no se avisan a sí mismos. */
  closingIssues(merged: MergedRef): Promise<IssueRef[]>
  /** El body del issue (su PRD). */
  issueBody(task: IssueRef): Promise<string>
  publish(
    ctx: PipelineExecutionContext,
    task: IssueRef,
    fields: EventFields,
  ): Promise<DomainEvent<unknown> | { skip: string }>
}

const refText = (ref: IssueRef) => `${ref.owner}/${ref.repo}#${ref.number}`

function refOfCard(card: BoardCard): IssueRef | undefined {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(card.ref)
  return match?.[1] && match[2] && match[3]
    ? { owner: match[1], repo: match[2], number: Number(match[3]) }
    : undefined
}

const sameRepo = (a: { owner: string; repo: string }, b: { owner: string; repo: string }) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()

/**
 * `issue.related_merged` a cada task del repo del PR, en una de `statuses` y sin PR propio, cuya
 * zona de impacto toca algún archivo del PR. Las que cierra el mismo PR no cuentan.
 */
export async function notifyRelatedMerged(
  port: RelatedMergedPort,
  ctx: PipelineExecutionContext,
  merged: MergedRef,
  statuses: readonly string[],
): Promise<Resolved> {
  const wanted = new Set(statuses.map((status) => status.toLowerCase()))
  const closing = (await port.closingIssues(merged)).map(refText)
  const candidates = (await port.cards()).flatMap((card) => {
    const ref = refOfCard(card)
    if (!ref || !sameRepo(ref, merged) || card.pr) return []
    if (!wanted.has((card.status ?? '').toLowerCase()) || closing.includes(refText(ref))) return []
    return [ref]
  })
  const prRef = `${merged.owner}/${merged.repo}#${merged.pr}`
  if (candidates.length === 0) return { skipped: `ninguna task de ${prRef} espera sin PR` }
  const files = await port.pullFiles(merged)
  const emitted: string[] = []
  for (const task of candidates) {
    const common = touched(impactPaths(await port.issueBody(task)), files)
    if (common.length === 0) continue
    const published = await port.publish(ctx, task, {
      emit: RELATED_MERGED,
      extra: { mergedPr: prRef, files: common },
    })
    if (!('skip' in published)) emitted.push(String(published.scope?.issue))
  }
  return emitted.length > 0
    ? { emitted }
    : { skipped: `${prRef} no toca la zona de impacto de ningún PRD` }
}
