import { DomainEvent, type Engine } from '@ia-flow/engine-v2'
import type { EventHandler, EventOutcome } from '@ia-flow/rules'
import type { EngineEvent } from '@ia-flow/shared'

/**
 * El punto de injerto real: un `EventHandler` más para `eventBus.subscribe`
 * de `@ia-flow/rules` (el mismo bus que ya alimenta `RuleEngineHandler`,
 * `WaitHandler`, `PrOutcomeHandler`), que reenvía cada evento al `Engine` de
 * `packages/engine-v2`.
 *
 * A propósito NO reemplaza a `RuleEngineHandler` — corre EN PARALELO detrás
 * de `IA_FLOW_ENGINE_V2=1` (ver daemon.ts). Las Pipeline/Agent que v2 tiene
 * registradas son las que decide `hydrate.ts`; si ninguna matchea, esto es
 * un no-op silencioso, exactamente como agregar cualquier otro `EventHandler`
 * que no le interesa a ese evento.
 */
export class EngineV2Bridge implements EventHandler {
  readonly id = 'engine-v2-bridge'

  constructor(private readonly engine: Engine) {}

  /** Nunca miente hacia el "no": dejar que `Engine.dispatch` (Pipeline.matches)
   *  decida es más barato que duplicar ACÁ el mismo filtro de scope/tipo. */
  handles(): boolean {
    return true
  }

  async handle(event: EngineEvent): Promise<EventOutcome> {
    const outcome = await this.engine.dispatch(this.toDomainEvent(event))
    return outcome
  }

  private toDomainEvent(event: EngineEvent): DomainEvent {
    return new DomainEvent(event.type, event.payload, {
      id: event.id,
      scope: {
        projectId: event.scope.projectId,
        repos: event.scope.repos,
        issueId: event.scope.issueId,
      },
      occurredAt: new Date(event.occurredAt),
      causationId: event.causationId,
      depth: event.depth,
    })
  }
}
