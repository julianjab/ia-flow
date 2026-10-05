import { END, type ExitRoute, type ExitRoutes, type InterruptRoute } from '../routing/ExitRoutes.js'
import {
  type PipelineExecutionContext,
  Runnable,
  type RunnableProps,
  type StepKind,
  type StepOutcome,
} from './Runnable.js'

/** Las dos salidas de un grupo. Fijas: el grupo no tiene modelo que elija otra. */
export const GROUP_PASSED = 'passed'
export const GROUP_FAILED = 'failed'

/** Cuándo pasa un grupo, mirando la salida de cada miembro que corrió: `all` = todos eligieron
 *  una de esas salidas; `any` = al menos uno. */
export type GroupUntil = { all: string[] } | { any: string[] }

export interface ParallelGroupProps extends RunnableProps {
  /** Obligatorio: es la clave de `ctx.steps`, del span y de `routes.<id>` en la pipeline. */
  id: string
  /** Los pasos que corren a la vez. Agentes que no pausan; sus salidas son veredicto y reporte,
   *  nunca transición (ver `PipelineGraph`). */
  members: Runnable[]
  until: GroupUntil
  /** A dónde lleva cada veredicto. Sin `to`, el grupo termina ahí. */
  routes?: { passed?: ExitRoute; failed?: ExitRoute }
  /** El reporte de cierre del GRUPO. Default: ninguno — cada miembro ya publica el suyo. */
  report?: Runnable | null
  /** Qué correr si lo interrumpen (una regla con `ifRunning: interrupt`): una vez por grupo. Su
   *  `onError` (de `RunnableProps`) corre si el grupo tira — un miembro falló o terminó sin
   *  salida —, también una vez. */
  onInterrupt?: InterruptRoute
}

/** Cómo terminó UN miembro que corrió: la salida que eligió y su resumen. */
export interface MemberVerdict {
  exit: string
  summary?: string
}

/** Lo que deja un grupo en `ctx.steps[<id>]`. `passed` ausente = no corrió ningún miembro. */
export interface GroupResult {
  passed?: boolean
  members: Record<string, MemberVerdict>
  /** Interrumpido: en qué quedó cada miembro que cedió su turno (lo que entregó en `yield_turn`,
   *  o su resumen). Es lo que lee el `onInterrupt` del grupo en `steps.interruption.progress`. */
  progress?: Record<string, string>
}

/**
 * Varios pasos que corren A LA VEZ dentro de la misma ejecución — ej. el reviewer y el e2e sobre
 * el mismo PR — y un veredicto combinado (`until`) que elige la salida del grupo: `passed` o
 * `failed`.
 *
 * Un loop se sigue armando con un evento: `failed` lleva a un destino que mueve la tarjeta (a
 * Build), nunca a otro agente de la pipeline. El grupo no levanta la regla de "sin ciclos".
 *
 * Lo corre `StepRunner` (`members` es su señal): cada miembro con su `when`, su span y el reporte
 * de la salida que eligió; `run` acá no se llama.
 */
export class ParallelGroup extends Runnable {
  override readonly id: string
  private readonly memberSteps: Runnable[]
  readonly until: GroupUntil
  private readonly props: ParallelGroupProps

  constructor(props: ParallelGroupProps) {
    super(props)
    if (props.members.length < 2) {
      throw new Error(`ParallelGroup(${props.id}): un grupo necesita al menos dos pasos`)
    }
    const wanted = 'all' in props.until ? props.until.all : props.until.any
    if (wanted.length === 0) {
      throw new Error(`ParallelGroup(${props.id}): \`until\` tiene que nombrar al menos una salida`)
    }
    this.id = props.id
    this.memberSteps = props.members
    this.until = props.until
    this.props = props
  }

  override get kind(): StepKind {
    return 'group'
  }

  override get members(): Runnable[] {
    return this.memberSteps
  }

  /** Las salidas que `until` acepta como "pasó". */
  get passingExits(): string[] {
    return 'all' in this.until ? this.until.all : this.until.any
  }

  override get exitRoutes(): ExitRoutes {
    const routes = this.props.routes ?? {}
    return {
      routes: {
        [GROUP_PASSED]: { when: 'Pasó el grupo', ...routes.passed, to: routes.passed?.to ?? END },
        [GROUP_FAILED]: {
          when: 'No pasó el grupo',
          ...routes.failed,
          to: routes.failed?.to ?? END,
        },
      },
      report: this.props.report ?? null,
      ...(this.onError !== undefined ? { onError: this.onError } : {}),
      ...(this.props.onInterrupt ? { onInterrupt: this.props.onInterrupt } : {}),
    }
  }

  /** El veredicto: cuentan sólo los miembros que corrieron (`verdicts`). Sin ninguno, no hay
   *  veredicto — un `all` sobre el vacío no puede dar "pasó". */
  verdict(verdicts: Record<string, MemberVerdict>): boolean | undefined {
    const exits = Object.values(verdicts).map((v) => v.exit)
    if (exits.length === 0) return undefined
    const passing = new Set(this.passingExits)
    return 'all' in this.until
      ? exits.every((exit) => passing.has(exit))
      : exits.some((exit) => passing.has(exit))
  }

  override outcome(output: unknown): StepOutcome {
    const result = output as GroupResult
    if (result.passed === undefined) return { kind: 'output', output }
    return {
      kind: 'exit',
      output,
      exit: result.passed ? GROUP_PASSED : GROUP_FAILED,
      payload: {},
    }
  }

  override async run(_ctx: PipelineExecutionContext): Promise<unknown> {
    throw new Error(`ParallelGroup(${this.id}): lo corre StepRunner, no se llama directo`)
  }
}
