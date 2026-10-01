import type { DomainEvent } from '../events/DomainEvent.js'
import type { DispatchPlan } from './DispatchPlanner.js'
import type { DispatchOutcome } from './RunLauncher.js'

/**
 * Qué hizo una pipeline con un evento:
 * - `ran`: corrió (o se resolvió contra la ejecución de su task: esperó, se inyectó, reanudó).
 * - `mismatch`: no pasó su filtro (el de la fuente, `on`, scope, `when`, `whenText`) — `reason`.
 * - `lost_to_exclusive`: pasó, pero la tapó una `exclusive` de mayor prioridad — `reason` la nombra.
 */
export interface DispatchDecision {
  pipelineId: string
  /** El `id` de su `PipelineSource` (el proyecto), o `''` si la fuente no tiene. */
  sourceId: string
  verdict: 'ran' | 'mismatch' | 'lost_to_exclusive'
  reason?: string
}

/** Un evento despachado y qué se decidió con él — una entrada por `Engine.dispatch`. */
export interface DispatchRecord {
  event: DomainEvent<any>
  decisions: DispatchDecision[]
  /** `error`: el despacho tiró (leer las reglas, o alguna corrida que esperaba) — ver `error`. */
  outcome: DispatchOutcome | 'error'
  error?: string
  /** La ejecución que el evento abrió, alimentó o reanudó, si se sabe. */
  executionId?: string
}

/**
 * Dónde anota el engine cada evento que despacha (`EngineOptions.dispatchJournal`), para
 * contestar después "¿qué pasó con este evento?". Se anota una vez, cuando el despacho termina —
 * con el resultado real —, también si lo descartó el tope de profundidad o si tiró. Uno que tira no
 * corta el despacho: se loguea y sigue.
 */
export interface DispatchJournal {
  record(entry: DispatchRecord): void
}

/**
 * Las decisiones de un plan, sólo de las pipelines que escuchan el tipo del evento — las que
 * escuchan otros tipos serían ruido (el mismo criterio que el span event `pipeline.match`).
 */
export function dispatchDecisions(plan: DispatchPlan, event: DomainEvent<any>): DispatchDecision[] {
  const running = new Set(plan.toRun.map(({ pipeline }) => pipeline))
  const decisions: DispatchDecision[] = []
  for (const { pipeline, source, mismatch } of plan.candidates) {
    if (!pipeline.on.includes(event.type)) continue
    const base = { pipelineId: pipeline.id, sourceId: source.id ?? '' }
    if (running.has(pipeline)) decisions.push({ ...base, verdict: 'ran' })
    else if (mismatch) decisions.push({ ...base, verdict: 'mismatch', reason: mismatch })
    else {
      decisions.push({
        ...base,
        verdict: 'lost_to_exclusive',
        reason: `la tapa la exclusive "${plan.winningExclusive?.id}"`,
      })
    }
  }
  return decisions
}
