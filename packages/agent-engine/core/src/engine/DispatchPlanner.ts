import { createLogger, tagged } from '@ia-flow/telemetry'
import type { TextClassifier } from '../condition/TextClassifier.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { Checkpoint, Pipeline } from '../pipeline/Pipeline.js'
import type { PipelineSource } from './PipelineSource.js'
import { planTag } from './tracing.js'

/** Una pipeline con la fuente de la que salió — sus defaults son los de ESA fuente. */
export interface Candidate {
  pipeline: Pipeline
  source: PipelineSource
  /** Por qué no corre, si no corre por la fuente o por la propia pipeline. */
  mismatch?: string
}

/** Qué corre para un evento, y lo necesario para explicar por qué no corre el resto. */
export interface DispatchPlan {
  candidates: Candidate[]
  toRun: Candidate[]
  winningExclusive?: Pipeline
}

/**
 * Decide qué pipelines corren para un evento, leyendo las fuentes en vivo en cada llamada. Puro
 * sobre `PipelineSource[]`: no sabe de ejecuciones ni corre nada.
 */
export class DispatchPlanner {
  readonly log = createLogger('agent-engine.engine')

  constructor(
    private readonly sources: PipelineSource[],
    /** Quién evalúa el `whenText` de una pipeline. */
    private readonly classifier?: TextClassifier,
  ) {}

  /**
   * Las pipelines que corren para `event`, en el mismo orden y con el mismo criterio que
   * `dispatch` — sin correrlas. Para previsualizar (un dry-run, un test) sin duplicar la cascada.
   */
  async select(event: DomainEvent<any>): Promise<Pipeline[]> {
    return (await this.plan(event)).toRun.map(({ pipeline }) => pipeline)
  }

  /** El `plan` con el que `dispatch` se compromete — a diferencia de `select`, queda en la traza. */
  @tagged(planTag)
  async decide(event: DomainEvent<any>): Promise<DispatchPlan> {
    return this.plan(event)
  }

  /**
   * La cascada de filtros: primero el `when` de cada fuente (el proyecto) — si no pasa, ninguna
   * de sus pipelines se evalúa —, después cada pipeline (`on`, scope, `when`)
   * y, para las que pasaron, su `whenText`. Entre las que
   * pasan, corren TODAS las no-exclusive; si alguna es `exclusive`, sólo la de mayor prioridad
   * (menor `position`) entre las exclusive, MÁS cualquier otra de prioridad todavía mayor. El
   * `when` de cada paso se evalúa después, al correr la pipeline.
   */
  async plan(event: DomainEvent<any>): Promise<DispatchPlan> {
    const candidates: Candidate[] = []
    for (const source of this.sources) {
      const sourceMismatch = source.explainMismatch?.(event)
      for (const pipeline of await source.list()) {
        const mismatch = sourceMismatch ?? pipeline.explainMismatch(event)
        candidates.push({ pipeline, source, ...(mismatch ? { mismatch } : {}) })
      }
    }
    // El gate semántico, sólo sobre las que ya pasaron todo lo barato, y antes de elegir la
    // exclusive: una que el modelo descarta no tapa a otra.
    await Promise.all(
      candidates
        .filter((candidate) => !candidate.mismatch && candidate.pipeline.whenText)
        .map(async (candidate) => {
          const mismatch = await candidate.pipeline.explainText(event, this.classifier)
          if (mismatch) candidate.mismatch = mismatch
        }),
    )
    const matched = candidates.filter((candidate) => !candidate.mismatch)
    const winningExclusive = matched
      .map(({ pipeline }) => pipeline)
      .filter((pipeline) => pipeline.exclusive)
      .sort((a, b) => a.position - b.position)[0]
    const toRun = winningExclusive
      ? matched.filter(
          ({ pipeline }) =>
            pipeline === winningExclusive || pipeline.position < winningExclusive.position,
        )
      : matched
    return { candidates, toRun, winningExclusive }
  }

  /** La pipeline de un checkpoint, en SU fuente: dos proyectos pueden tener una pipeline con el
   *  mismo id. Sin id de fuente, sólo si no es ambigua. */
  async findCandidate({ pipelineId, sourceId }: Checkpoint): Promise<Candidate> {
    const found: Candidate[] = []
    for (const source of this.sources) {
      if (sourceId !== undefined && source.id !== sourceId) continue
      for (const pipeline of await source.list()) {
        if (pipeline.id === pipelineId) found.push({ pipeline, source })
      }
    }
    const where = sourceId !== undefined ? ` en "${sourceId}"` : ''
    if (found.length === 0)
      throw new Error(`no hay una pipeline "${pipelineId}"${where} para reanudar`)
    if (found.length > 1) {
      throw new Error(
        `hay ${found.length} pipelines "${pipelineId}" y la pausa no dice de qué fuente es`,
      )
    }
    return found[0] as Candidate
  }
}
