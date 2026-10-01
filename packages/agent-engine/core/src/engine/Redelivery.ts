import {
  captureSpanLink,
  createLogger,
  inFreshContext,
  type SpanLink,
  traced,
} from '@ia-flow/telemetry'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { DispatchPlanner } from './DispatchPlanner.js'
import type { ExecutionCoordinator } from './ExecutionCoordinator.js'
import type { DispatchOutcome, RunLauncher } from './RunLauncher.js'
import { redeliverTrace } from './tracing.js'

export interface RedeliveryOptions {
  planner: DispatchPlanner
  launcher: RunLauncher
  coordinator: ExecutionCoordinator
}

/**
 * Lo que se le inyectó a una ejecución y ningún agente llegó a leer (llegó después de su última
 * vuelta) vuelve a despacharse al cerrarla o pausarla (si la despierta, reanuda su pausa) — contra
 * las reglas CON agentes: las reacciones sin agentes ya corrieron con él la primera vez. Ya sin
 * nada corriendo, arranca normal. Así un evento inyectado nunca se pierde.
 *
 * Cada re-despacho corre en una traza nueva (no es parte de la corrida que cierra) que cita la del
 * despacho que lo inyectó: desde el evento se llega a lo que terminó causando.
 */
export class Redelivery {
  readonly log = createLogger('agent-engine.engine')
  private readonly planner: DispatchPlanner
  private readonly launcher: RunLauncher
  private readonly coordinator: ExecutionCoordinator
  /** El span del despacho que inyectó cada evento: si nadie lo lee, su re-despacho abre una
   *  traza nueva que lo cita (`redeliverTrace`). */
  private readonly origins = new WeakMap<DomainEvent<any>, SpanLink>()

  constructor(opts: RedeliveryOptions) {
    this.planner = opts.planner
    this.launcher = opts.launcher
    this.coordinator = opts.coordinator
  }

  /** Recuerda el span activo como el origen de `event` — lo llama el despacho que lo inyectó. */
  rememberOrigin(event: DomainEvent<any>): void {
    const origin = captureSpanLink()
    if (origin) this.origins.set(event, origin)
  }

  redispatch(unread: DomainEvent<any>[], executionId: string): void {
    for (const event of unread) {
      this.log.info(`evento "${event.type}" sin leer en ${executionId}: se vuelve a despachar`, {
        'ia.execution.id': executionId,
      })
      const origin = this.origins.get(event)
      // El error ya lo logueó `@traced` adentro de su span; acá sólo no queda sin manejar.
      inFreshContext(() => this.redeliver(event, executionId, origin)).catch(() => {})
    }
  }

  @traced(redeliverTrace)
  private async redeliver(
    event: DomainEvent<any>,
    _executionId: string,
    _origin: SpanLink | undefined,
  ): Promise<DispatchOutcome> {
    const { toRun } = await this.planner.plan(event)
    // Si la ejecución que lo dejó sin leer se pausó esperando justo este evento, lo recibe su
    // pausa — igual que en `dispatch`.
    const offer = this.coordinator.wake(event)
    return this.launcher.launch(
      toRun.filter((candidate) => candidate.pipeline.needsExecution),
      event,
      offer,
      (candidate) => this.coordinator.resolveRunning(candidate, event, offer),
    )
  }
}
