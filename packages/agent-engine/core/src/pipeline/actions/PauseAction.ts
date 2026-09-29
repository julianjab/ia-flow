import { EventFilter, type EventFilterProps } from '../../condition/EventFilter.js'
import { type RouteTo, routeTargets } from '../../routing/ExitRoutes.js'
import {
  type PipelineExecutionContext,
  type Resumable,
  Runnable,
  type RunnableProps,
  type StepOutcome,
} from '../Runnable.js'
import { Pause, TIMEOUT_BRANCH } from './Pause.js'

/** Una forma de reanudar: los eventos que la despiertan y qué corre al despertar. */
export interface PauseBranchProps extends EventFilterProps {
  /** Qué corre al reanudar por esta rama (después sigue la pipeline). `END` o nada: sólo sigue. */
  to?: RouteTo
}

export interface PauseActionProps extends RunnableProps {
  /** Obligatorio: el `Checkpoint` guarda la pausa por id, para encontrarla al reanudar. */
  id: string
  /** Las formas de reanudar, por nombre (`green`, `red`, …). Al menos una, o un `timeout`. */
  branches?: Record<string, PauseBranchProps>
  /** Si no llega nada en `afterMs`, reanuda por la rama `timeout` (con su `to`). Sin esto, una
   *  pausa espera hasta que llegue una de sus ramas o la reemplace otra corrida de la task. */
  timeout?: { afterMs: number; to?: RouteTo }
}

/**
 * Un paso que pausa la ejecución hasta que llegue un evento: el engine corta la pipeline acá,
 * libera el lugar de la task y, cuando llega un evento que pasa una de sus ramas, sigue desde acá
 * corriendo el `to` de esa rama. Va como destino de una salida (ej. después de abrir el PR,
 * esperar el CI) o en `do[]`. Sólo corre dentro de una ejecución (`EngineOptions.executions`).
 */
export class PauseAction extends Runnable implements Resumable {
  declare readonly id: string
  private readonly branches: Array<{ name: string; filter: EventFilter; to?: RouteTo }>
  readonly timeout?: { afterMs: number; to?: RouteTo }

  constructor(props: PauseActionProps) {
    super(props)
    this.branches = Object.entries(props.branches ?? {}).map(([name, branch]) => ({
      name,
      filter: new EventFilter(branch),
      ...(branch.to !== undefined ? { to: branch.to } : {}),
    }))
    this.timeout = props.timeout
    if (this.branches.some((branch) => branch.name === TIMEOUT_BRANCH)) {
      throw new Error(`PauseAction(${props.id}): "${TIMEOUT_BRANCH}" es la rama de \`timeout\``)
    }
    if (this.branches.length === 0 && !this.timeout) {
      throw new Error(`PauseAction(${props.id}): sin ramas ni timeout nunca se reanudaría`)
    }
  }

  /** Lo que corre al reanudar por `branch`. */
  targetsOf(branch: string): Runnable[] {
    if (branch === TIMEOUT_BRANCH) return routeTargets(this.timeout?.to)
    return routeTargets(this.branches.find((b) => b.name === branch)?.to)
  }

  /** Las ramas por las que se puede reanudar, `timeout` incluida si la tiene. */
  get branchNames(): string[] {
    return [...this.branches.map((b) => b.name), ...(this.timeout ? [TIMEOUT_BRANCH] : [])]
  }

  /** Todo lo que puede correr al reanudar, por cualquier rama. */
  get allTargets(): Runnable[] {
    return [
      ...this.branches.flatMap((branch) => routeTargets(branch.to)),
      ...routeTargets(this.timeout?.to),
    ]
  }

  override asResumable(): Resumable {
    return this
  }

  override outcome(output: unknown): StepOutcome {
    return { kind: 'pause', pause: output as Pause }
  }

  /** Devuelve la `Pause`: la `Pipeline` la ve, corta y le pide a la ejecución que se pause. */
  async run(_ctx: PipelineExecutionContext): Promise<Pause> {
    return new Pause(
      this.id,
      this.branches.map(({ name, filter }) => ({ name, filter })),
      this.timeout ? Date.now() + this.timeout.afterMs : undefined,
    )
  }
}
