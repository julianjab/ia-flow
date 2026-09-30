/**
 * El latido del runner: mientras sirve, cada minuto deja en los logs que el proceso sigue vivo y
 * cuántas ejecuciones tiene. El dashboard `ia-issue` lo usa para distinguir una ejecución que
 * corre de una que quedó abierta porque su proceso murió (un crash o un reinicio no alcanzan a
 * loguear su `cierra:`): una abierta sin latido de su proceso está cortada, no corriendo.
 */
import { createLogger } from '@ia-flow/telemetry'

/** Lo que el dashboard busca: cambiarlo es cambiar sus queries. */
export const HEARTBEAT_PREFIX = 'runner vivo:'
export const HEARTBEAT_EVERY_MS = 60_000

export interface HeartbeatStats {
  running: number
  waiting: number
  paused: number
}

const log = createLogger('ia-flow-runner-v2.heartbeat')

export function heartbeatLine(stats: HeartbeatStats): string {
  return `${HEARTBEAT_PREFIX} ${stats.running} corriendo · ${stats.paused} pausadas · ${stats.waiting} en cola`
}

/** Late ya y cada `everyMs`; devuelve cómo pararlo. */
export function startHeartbeat(
  stats: () => HeartbeatStats,
  everyMs = HEARTBEAT_EVERY_MS,
  emit: (line: string, stats: HeartbeatStats) => void = (line, s) =>
    log.info(line, {
      'ia.runner.executions.running': s.running,
      'ia.runner.executions.paused': s.paused,
      'ia.runner.executions.waiting': s.waiting,
    }),
): () => void {
  const beat = () => {
    const current = stats()
    emit(heartbeatLine(current), current)
  }
  beat()
  const timer = setInterval(beat, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
