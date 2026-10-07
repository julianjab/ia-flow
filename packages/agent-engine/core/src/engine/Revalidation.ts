import type { Logger } from '@ia-flow/telemetry'
import type { DomainEvent } from '../events/DomainEvent.js'
import type { Candidate } from './DispatchPlanner.js'

/** Lo que da los hechos de AHORA para un evento (ver `EngineOptions.revalidate`). */
export type Revalidate = (event: DomainEvent<any>) => Promise<DomainEvent<any> | undefined>

/** Una pipeline que esperó su turno, al tomarlo: corre con `event`, o ya no aplica (`stale`). */
export type StillApplies = { event: DomainEvent<any> } | { stale: string }

/**
 * Una pipeline que esperó su turno detrás de otra ejecución de la task, al tomarlo: vuelve a pasar
 * los filtros baratos —el de su fuente y el suyo (`on`, scope, `when`)— contra el evento con los
 * hechos de ahora (`revalidate`). Lo que hizo la ejecución anterior (mover la card, sacarle un
 * label) puede haber dejado sin efecto lo que se decidió cuando llegó el evento.
 *
 * El `whenText` no se repite: cuesta un modelo y lo que evalúa es el texto del evento, que no
 * cambió. Sin `revalidate`, o si no sabe (`undefined`) o falla, corre con el evento original, como
 * siempre.
 */
export async function stillApplies(
  candidate: Candidate,
  event: DomainEvent<any>,
  revalidate: Revalidate | undefined,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<StillApplies> {
  if (!revalidate) return { event }
  const { pipeline, source } = candidate
  let fresh: DomainEvent<any> | undefined
  try {
    fresh = await revalidate(event)
  } catch (err) {
    log.warn(
      `${pipeline.id}: no pude releer "${event.type}" antes de correr — sigue con el original: ${err instanceof Error ? err.message : String(err)}`,
      { 'ia.pipeline.id': pipeline.id, 'ia.event.id': event.id },
    )
    return { event }
  }
  if (!fresh) return { event }
  const mismatch = source.explainMismatch?.(fresh) ?? pipeline.explainMismatch(fresh)
  if (!mismatch) return { event: fresh }
  log.info(`${pipeline.id}: esperó su turno y ya no aplica — ${mismatch}`, {
    'ia.pipeline.id': pipeline.id,
    'ia.event.id': event.id,
  })
  return { stale: `ya no aplica al tomar su turno: ${mismatch}` }
}
