// Traduce `pr.merged` / `pr.closed` / `pr.review_submitted` en la señal de
// resultado que le faltaba a `execution_logs`: no cómo terminó el run, sino
// si lo que produjo sirvió (issue #141).
//
// La atribución run → PR es deliberadamente simple: el PR se identifica por
// su branch (`payload.pr.head.ref`), y `task/<taskId>` es la convención de
// `packages/workspace/src/layout.ts` — de ahí sale el `taskId` sin ambigüedad
// en el caso común (sin linked branch propia). Dentro de esa task se toma el
// ÚLTIMO run de agente (no sub-agente): no hay tool dedicada de creación de
// PR, así que no hay forma de saber cuál de varios agentes en cadena
// (builder, reviewer, e2e) corrió `gh pr create` — el último es la
// aproximación correcta en el caso común de un solo builder por task.
//
// Best-effort en las dos puntas: un branch que no seguía la convención, o una
// task sin runs de agente, se loguea y se saltea — nunca rompe el pipeline.

import type { EventHandler, EventOutcome } from '@ia-flow/rules'
import type { EngineEvent } from '@ia-flow/shared'
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
      // Los más recientes primero (list() ya ordena por started_at DESC);
      // parentId descarta sub-agentes, que corren sobre la misma task que su
      // padre y no son "el run que abrió el PR".
      const runs = this.logs.list({ taskId, kind: 'agent', limit: 10 })
      const run = runs.find((r) => !r.parentId)
      if (!run) {
        log.debug({ type: event.type, taskId }, 'Sin run de agente para esta task — se saltea')
        return 'skipped'
      }

      const prNumber = payload.pr?.number ?? run.prNumber ?? null
      if (event.type === PR_MERGED) {
        this.logs.update(run.id, { prMerged: true, prNumber })
      } else if (event.type === PR_CLOSED) {
        this.logs.update(run.id, { prMerged: false, prNumber })
      } else {
        this.logs.update(run.id, { reviewRounds: (run.reviewRounds ?? 0) + 1, prNumber })
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
