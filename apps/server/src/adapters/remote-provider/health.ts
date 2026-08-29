// Lógica pura del health de los providers remotos — sin red, sin timers, sin
// registry. Vive separada de RemoteProviderHealthMonitor.ts (que sí hace
// fetch y maneja el intervalo) para poder testear las transiciones sin
// levantar un agent-host ni esperar un tick.
import type { RemoteProviderHealth } from '@ia-flow/shared'

/** Resultado crudo de una sonda, tal como lo produce el monitor. */
export type ProbeResult = { ok: true; latencyMs: number } | { ok: false; error: string }

export const UNKNOWN_HEALTH: RemoteProviderHealth = { status: 'unknown', consecutiveFailures: 0 }

/**
 * Aplica una sonda sobre el health previo.
 *
 * Un solo fallo alcanza para marcarlo `down` a propósito: el costo de
 * sacarlo es que el issue se **difiere** (se reintenta cuando vuelve), no que
 * falle — mientras que dejarlo elegible un tick más significa despachar
 * contra un agent-host que ya sabemos que no está y hacer fallar el run del
 * agente de verdad. `consecutiveFailures` se sigue contando para poder
 * mostrar "está caído hace rato" en la UI.
 */
export function applyProbe(
  prev: RemoteProviderHealth,
  probe: ProbeResult,
  at: string,
): RemoteProviderHealth {
  if (probe.ok) {
    return { status: 'ok', checkedAt: at, latencyMs: probe.latencyMs, consecutiveFailures: 0 }
  }
  return {
    status: 'down',
    checkedAt: at,
    error: probe.error,
    consecutiveFailures: prev.consecutiveFailures + 1,
  }
}

/** Un remoto está disponible (registrado y elegible) sólo con health `ok`.
 *  `unknown` NO alcanza: preferimos diferir un dispatch hasta la primera
 *  sonda antes que mandarlo a ciegas. */
export function isAvailable(health: RemoteProviderHealth): boolean {
  return health.status === 'ok'
}
