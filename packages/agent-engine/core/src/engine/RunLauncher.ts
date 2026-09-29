import { createLogger } from '@ia-flow/telemetry'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { Candidate } from './DispatchPlanner.js'
import type { Offer, Resolution } from './ExecutionCoordinator.js'

/** `injected`: nada arrancó, pero el evento le llegó al paso activo de una ejecución en curso.
 *  `resumed`: reanudó una ejecución pausada de su task (y no arrancó nada más). */
export type DispatchOutcome = 'dispatched' | 'injected' | 'resumed' | 'skipped'

/**
 * Lanza las corridas de un evento: las que `dispatch` espera, en paralelo y juntando sus fallos, y
 * las desacopladas (`detach`), que corren sin que nadie las espere.
 */
export class RunLauncher {
  readonly log = createLogger('agent-engine.engine')

  /**
   * Corre las pipelines elegidas para `event`, resolviendo cada una contra la ejecución de su task
   * con `resolve` — y la reanudación, si el evento despertó una pausa. `resolve` se llama en orden,
   * intercalado con el lanzamiento de las desacopladas: cada una ocupa su task en el mismo tick, y
   * la siguiente la ve ocupada.
   */
  async launch(
    toRun: Candidate[],
    event: DomainEvent<any>,
    offer: Offer | undefined,
    resolve: (candidate: Candidate) => Resolution,
  ): Promise<DispatchOutcome> {
    const runs: Array<() => Promise<unknown>> = []
    const start = (run: () => Promise<unknown>, detach: boolean) => {
      if (detach) this.detach(run, event)
      else runs.push(run)
    }
    if (offer?.kind === 'resumed' && offer.run) start(offer.run, offer.detach ?? false)
    let others = false
    for (const candidate of toRun) {
      const { run, detach } = resolve(candidate)
      if (!run) continue
      others = true
      start(run, detach ?? false)
    }
    // Sin otras corridas, el resultado es lo que pasó con la ejecución de la task (o nada).
    const quiet = offer ? offer.kind : 'skipped'
    if (runs.length === 0) return others ? 'dispatched' : quiet
    // `Promise.allSettled`, no `Promise.all`: los pipelines matcheados son independientes, así
    // que un fallo en uno no debe cortar a los demás a mitad de camino — y quien llamó
    // `dispatch` (o el `AggregateError` de `EventBus.publish`, vía `start()`) tiene que ver
    // TODOS los fallos, no sólo el primero que ganó la carrera.
    const results = await Promise.allSettled(runs.map((run) => run()))
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `${failures.length} pipeline(s) failed for event "${event.type}"`,
      )
    }
    return others ? 'dispatched' : quiet
  }

  /**
   * Una corrida que no se espera: la de un evento nacido dentro de una ejecución que tiene que abrir
   * OTRA (otra task). `EmitAction` espera a `publish`, y `publish` a `dispatch`: si esperara acá a
   * que esa otra task tenga turno y lugar, la ejecución que lo emitió lo esperaría ocupando su
   * propio lugar — con el tope agotado, o con dos tasks que se emiten entre sí, nunca terminaría
   * ninguna. Sus errores van al log: nadie más los está esperando.
   */
  detach(run: () => Promise<unknown>, event: DomainEvent<any>): void {
    run().catch((err: unknown) => {
      this.log.error(
        `"${event.type}" (lanzado desde ${event.executionId}) falló: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }
}
