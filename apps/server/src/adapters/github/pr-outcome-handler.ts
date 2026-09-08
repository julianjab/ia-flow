// Traduce `pr.merged` / `pr.closed` / `pr.review_submitted` en la señal de
// resultado que le faltaba a `execution_logs`: no cómo terminó el run, sino
// si lo que produjo sirvió (issue #141).
//
// La atribución run → PR es deliberadamente simple: el PR se identifica por
// su branch (`payload.pr.head.ref`), y `task/<taskId>` es la convención de
// `packages/workspace/src/layout.ts` — de ahí sale el `taskId` sin ambigüedad
// en el caso común (sin linked branch propia). Dentro de esa task, PRIMERO se
// busca un run que ya tenga este `prNumber` (lo dejó un evento anterior del
// MISMO PR — típicamente `pr.review_submitted` antes que `pr.merged`, días
// después); si ninguno lo tiene todavía, se toma el ÚLTIMO run de agente (no
// sub-agente). Sin eso, tres eventos del mismo PR en momentos distintos
// (review, review, merge) podían repartirse entre runs DISTINTOS si el
// pipeline disparó un run nuevo sobre la task en el medio (un reviewer, un
// fixer) — exactamente el caso multi-ronda que `review_rounds`/`mergeRate`
// existen para medir.
//
// Best-effort en las tres puntas: un branch que no seguía la convención, una
// task sin runs de agente, o un run cuyo PR resuelto ya es OTRO PR distinto,
// se loguea y se saltea — nunca rompe el pipeline.
import type { EventHandler, EventOutcome } from '@ia-flow/rules'
import type { EngineEvent, ExecutionLog } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../../domain/ports/IExecutionLogRepository.js'
import { createLogger } from '../../logger.js'
import { PR_CLOSED, PR_MERGED, PR_REVIEW_SUBMITTED } from './webhook-events.js'

const log = createLogger('pr-outcome')

const HANDLED_TYPES = new Set<string>([PR_MERGED, PR_CLOSED, PR_REVIEW_SUBMITTED])

interface PrEventPayload {
  pr?: { number?: number; head?: { ref?: string } }
}

const BRANCH_PREFIX = 'task/'

/** `task/<id>` → `<id>` — ver el comentario del módulo. `null` cuando el
 *  branch no sigue la convención (linked branch manual, PR ajeno al engine). */
function taskIdFromBranch(branch: string | undefined): string | null {
  if (!branch?.startsWith(BRANCH_PREFIX)) return null
  const id = branch.slice(BRANCH_PREFIX.length)
  return id.length > 0 ? id : null
}

/**
 * El run al que atribuir este evento, dentro de los runs de agente (no
 * sub-agente) de la task — ver el comentario del módulo para el orden de
 * preferencia. `null` cuando no hay ninguno, o cuando el único candidato ya
 * tiene un PR resuelto que NO es éste (ambiguo — mejor no pisarlo).
 */
function selectRun(runs: ExecutionLog[], prNumber: number | undefined): ExecutionLog | null {
  const ownRuns = runs.filter((r) => !r.parentId)
  const matching = prNumber != null ? ownRuns.find((r) => r.prNumber === prNumber) : undefined
  if (matching) return matching

  const fallback = ownRuns[0]
  if (!fallback) return null
  const resolvedForOtherPr =
    fallback.prNumber != null && prNumber != null && fallback.prNumber !== prNumber
  return resolvedForOtherPr ? null : fallback
}

export class PrOutcomeHandler implements EventHandler {
  readonly id = 'pr-outcome'

  constructor(private readonly logs: IExecutionLogRepository) {}

  handles(event: EngineEvent): boolean {
    return HANDLED_TYPES.has(event.type)
  }

  async handle(event: EngineEvent): Promise<EventOutcome> {
    const payload = event.payload as PrEventPayload
    const taskId = taskIdFromBranch(payload.pr?.head?.ref)
    if (!taskId) {
      log.debug(
        { type: event.type, branch: payload.pr?.head?.ref },
        'PR sin task atribuible por convención de branch — se saltea',
      )
      return 'skipped'
    }

    try {
      // Sin `limit`: list() ya ordena por started_at DESC, y cortar la
      // ventana ANTES de filtrar sub-agentes podía dejar sólo hijos de
      // `run_agent` en una task con muchos — see review del PR.
      const runs = this.logs.list({ taskId, kind: 'agent' })
      const run = selectRun(runs, payload.pr?.number)
      if (!run) {
        log.debug({ type: event.type, taskId }, 'Sin run atribuible para esta task — se saltea')
        return 'skipped'
      }

      const prNumber = payload.pr?.number ?? run.prNumber ?? null
      if (event.type === PR_MERGED) {
        this.logs.update(run.id, { prMerged: true, prNumber })
      } else if (event.type === PR_CLOSED) {
        this.logs.update(run.id, { prMerged: false, prNumber })
      } else {
        // Incremento atómico en el repo — dos reviews casi simultáneas no se
        // pueden pisar leyendo `run.reviewRounds` acá y escribiendo después.
        this.logs.incrementReviewRounds(run.id)
        if (run.prNumber !== prNumber) this.logs.update(run.id, { prNumber })
      }
      return 'dispatched'
    } catch (err) {
      // Best-effort (criterio de aceptación #4 del issue): un evento que no
      // se puede atribuir no puede voltear el pipeline de webhooks.
      log.warn({ err, type: event.type, taskId }, 'No se pudo registrar el resultado del PR')
      return 'skipped'
    }
  }
}
