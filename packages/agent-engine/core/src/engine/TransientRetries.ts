import { createLogger, inFreshContext } from '@ia-flow/telemetry'
import type { DomainEvent } from '../events/DomainEvent.js'
import { retriesLeft, retryAfterMsOf } from '../pipeline/transient.js'
import type { DispatchPlanner } from './DispatchPlanner.js'
import type { ExecutionCoordinator } from './ExecutionCoordinator.js'
import type { RunLauncher } from './RunLauncher.js'

/** La espera antes del primer reintento; se duplica en cada uno. */
export const TRANSIENT_RETRY_BASE_MS = 60_000
/** La espera más larga, aunque el upstream pida más. */
export const TRANSIENT_RETRY_MAX_MS = 15 * 60_000

export interface TransientRetriesOptions {
  planner: DispatchPlanner
  launcher: RunLauncher
  coordinator: ExecutionCoordinator
}

interface Scheduled {
  at: number
  event: DomainEvent<any>
  pipelineIds: Set<string>
}

/**
 * Las corridas que fallaron por infraestructura (`pipeline/transient.ts`) se vuelven a despachar
 * más tarde: el mismo evento, con `transientRetries` + 1, contra SÓLO las pipelines que fallaron
 * (las que anduvieron no corren dos veces). La espera es la que pidió el upstream
 * (`retryAfterMs`) o 60 s × 2ⁿ, y vence con `Engine.tick` —el engine no tiene reloj—. El
 * re-despacho pasa por las reglas como cualquier evento (`ifRunning`, `revalidate`): si la task
 * ya no está donde estaba, no corre.
 *
 * Vive en memoria: un reinicio pierde los reintentos pendientes (la card queda sin `blocked` y
 * sin corrida; el próximo evento de la task la retoma).
 */
export class TransientRetries {
  readonly log = createLogger('agent-engine.engine')
  private readonly scheduled = new Map<string, Scheduled>()

  constructor(private readonly opts: TransientRetriesOptions) {}

  /** `pipelineId` falló por infraestructura con `event`: lo programa, si le quedan intentos. */
  record(event: DomainEvent<any>, pipelineId: string, error: unknown, now = Date.now()): void {
    if (!retriesLeft(event)) return
    const attempt = event.transientRetries ?? 0
    const backoff = TRANSIENT_RETRY_BASE_MS * 2 ** attempt
    const delay = Math.min(Math.max(backoff, retryAfterMsOf(error) ?? 0), TRANSIENT_RETRY_MAX_MS)
    const existing = this.scheduled.get(event.id)
    if (existing) {
      existing.pipelineIds.add(pipelineId)
      existing.at = Math.max(existing.at, now + delay)
    } else {
      this.scheduled.set(event.id, { at: now + delay, event, pipelineIds: new Set([pipelineId]) })
    }
    this.log.warn(
      `"${event.type}" → ${pipelineId}: falló por infraestructura, se reintenta en ${Math.round(delay / 1000)} s (intento ${attempt + 1})`,
      { 'ia.event.id': event.id, 'ia.pipeline.id': pipelineId },
    )
  }

  /** Cuántos reintentos esperan su turno. */
  get pending(): number {
    return this.scheduled.size
  }

  /** Re-despacha los que vencieron. */
  fire(now = Date.now()): void {
    for (const [id, entry] of [...this.scheduled]) {
      if (entry.at > now) continue
      this.scheduled.delete(id)
      const retry: DomainEvent<any> = {
        ...entry.event,
        transientRetries: (entry.event.transientRetries ?? 0) + 1,
      }
      // Los fallos los anota el `record` del launcher (el siguiente intento) o el `onError`.
      inFreshContext(() => this.redeliver(retry, entry.pipelineIds)).catch(() => {})
    }
  }

  private async redeliver(event: DomainEvent<any>, pipelineIds: Set<string>): Promise<void> {
    const { planner, launcher, coordinator } = this.opts
    const { toRun } = await planner.plan(event)
    const again = toRun.filter((candidate) => pipelineIds.has(candidate.pipeline.id))
    this.log.info(
      `"${event.type}": reintento ${event.transientRetries} de ${[...pipelineIds].join(', ')}${again.length === 0 ? ' — ya no aplica' : ''}`,
      { 'ia.event.id': event.id },
    )
    await launcher.launch(again, event, undefined, (candidate) =>
      coordinator.resolveRunning(candidate, event, undefined),
    )
  }
}
