import { EventFilter, type EventFilterProps } from '../condition/EventFilter.js'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { Runnable } from './Runnable.js'

export interface MaxRunsProps {
  /** Cuántas corridas que cuentan admite la task antes de agotarse. */
  max: number
  /** Qué contador usa. Default: el id de la pipeline. Dos pipelines con el mismo nombre comparten
   *  la cuenta (ej. las dos puntas de un loop). */
  counter?: string
  /** Qué disparos cuentan (`{ on, when }`). Sin filtros, todos. Así se deja afuera lo que hace
   *  una persona: en el evento no hay una señal uniforme de "lo hizo un humano", así que lo
   *  declara quien escribe la pipeline (ej. `sender` que termina en `[bot]`). */
  counts?: EventFilterProps[]
  /** Cualquier evento de la task que pase uno de éstos pone la cuenta en cero — típicamente lo
   *  que hace una persona (un comentario, una review): le da una ronda nueva. */
  resetOn?: EventFilterProps[]
  /** Si la última corrida contada es más vieja que esto, se cuenta desde cero. */
  windowMs?: number
  /** Qué corre en vez de la pipeline cuando la cuenta se agotó: acciones (avisar, bloquear). */
  onExhausted: Runnable[]
}

/**
 * El tope de corridas de una pipeline por task. Un loop entre agentes ("review → build →
 * review…") pasa por eventos, así que ningún grafo lo puede acotar: lo cuenta el engine, por task
 * (la clave de su ejecución), en el `ExecutionStore`.
 */
export class MaxRuns {
  readonly max: number
  readonly counter: string
  readonly windowMs?: number
  readonly onExhausted: Runnable[]
  private readonly countFilters: EventFilter[]
  private readonly resetFilters: EventFilter[]

  constructor(pipelineId: string, props: MaxRunsProps) {
    if (!Number.isInteger(props.max) || props.max < 1) {
      throw new Error(`Pipeline(${pipelineId}): maxRuns.max tiene que ser un entero ≥ 1`)
    }
    if (props.onExhausted.length === 0) {
      throw new Error(`Pipeline(${pipelineId}): maxRuns.onExhausted necesita al menos un paso`)
    }
    for (const step of props.onExhausted) {
      if (step.asResumable() !== undefined || step.exitRoutes !== undefined) {
        throw new Error(
          `Pipeline(${pipelineId}): maxRuns.onExhausted sólo lleva acciones ("${step.id ?? step.constructor.name}" ${step.asResumable() ? 'pausa' : 'es un agente'})`,
        )
      }
    }
    this.max = props.max
    this.counter = props.counter ?? pipelineId
    if (props.windowMs !== undefined) this.windowMs = props.windowMs
    this.onExhausted = props.onExhausted
    this.countFilters = (props.counts ?? []).map((filter) => new EventFilter(filter))
    this.resetFilters = (props.resetOn ?? []).map((filter) => new EventFilter(filter))
  }

  /** Si una corrida disparada por `event` cuenta para el tope. */
  counts(event: DomainEvent<any>): boolean {
    return this.countFilters.length === 0 || this.countFilters.some((f) => f.matches(event))
  }

  /** Si `event` pone la cuenta en cero. */
  resets(event: DomainEvent<any>): boolean {
    return this.resetFilters.some((filter) => filter.matches(event))
  }
}
