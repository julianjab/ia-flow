// Shared liveness poller for terminal-backed provider sessions.
//
// Both tmux and iterm providers spawn Claude out-of-process and hand a
// SessionHandle back to the orchestrator. If the user closes the tab (or
// tmux crashes, or the shell exits before Claude finished) the agent will
// never call complete_task / fail_task and the execution row would stay
// `finished_at IS NULL` forever, blocking any downstream task waiting on it.
//
// This module polls `handle.liveness()` and fires `onDead` once — but ONLY
// with positive evidence of death. Todo lo que no sea evidencia (`unknown`:
// tmux inejecutable, AppleScript colgado, el agent-host que hospeda la sesión
// reinició y perdió su mapa en memoria) tiene su propio presupuesto, mucho
// más largo, y al agotarse NO cancela: deja de vigilar y lo dice.
//
// La asimetría es deliberada. Un run colgado ocupa un slot y se ve en la UI;
// un run abandonado de más cuesta el trabajo que el agente ya hizo y deja el
// issue mudo — que es exactamente el incidente que motivó este archivo.

import type { Liveness, SessionHandle } from '@ia-flow/ai-providers'
import { createLogger } from './logger.js'

const log = createLogger('session-watchdog')

/** Por qué el watchdog soltó la sesión. Viaja al `error_msg` de
 *  `execution_logs` para que un cancel del watchdog no sea indistinguible de
 *  uno manual cuando alguien lea la tabla un mes después. */
export type WatchdogReason = 'confirmed-dead' | 'liveness-unknown'

export interface WatchOptions {
  /** How often to poll after the grace period. Default 10s — cheap enough for
   *  AppleScript / `tmux has-session`, high enough to not spam. */
  intervalMs?: number
  /** Delay before the first poll. The session needs a moment to register in
   *  the tmux server / iTerm2's session list; polling immediately would
   *  false-positive as dead. Default 5s. */
  graceMs?: number
  /** Consecutive `dead` readings required before firing `onDead`. A single
   *  negative reading can be a transient blip rather than the session
   *  actually being gone — firing on the first one tears down the in-memory
   *  pending-task entry (see pending-tasks.ts) even though the real terminal
   *  session, and the agent inside it, keeps running. Default 2 — one blip is
   *  tolerated, two in a row is treated as real. */
  confirmChecks?: number
  /** Cuánto tiempo seguido se tolera no poder saber nada antes de soltar la
   *  sesión con `liveness-unknown`. Default 10 min: dos órdenes de magnitud
   *  por encima de `confirmChecks * intervalMs`, porque `unknown` no es
   *  evidencia de nada y el caso típico (un agent-host que reinicia) se resuelve
   *  solo en segundos. Un `alive` intermedio resetea el presupuesto. */
  unknownBudgetMs?: number
}

const DEFAULT_INTERVAL = 10_000
const DEFAULT_GRACE = 5_000
const DEFAULT_CONFIRM_CHECKS = 2
const DEFAULT_UNKNOWN_BUDGET = 10 * 60_000

/**
 * Start polling `handle.liveness()`; call `onGone` at most once, con el motivo.
 *
 * Returns an `unwatch` fn that must be called when the run finishes normally
 * (complete_task / fail_task / manual cancel) so the poller doesn't fire
 * against a session we already tore down.
 */
export function watchSession(
  handle: SessionHandle,
  onGone: (reason: WatchdogReason) => void,
  opts: WatchOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL
  const graceMs = opts.graceMs ?? DEFAULT_GRACE
  const confirmChecks = Math.max(1, opts.confirmChecks ?? DEFAULT_CONFIRM_CHECKS)
  const unknownBudgetMs = Math.max(0, opts.unknownBudgetMs ?? DEFAULT_UNKNOWN_BUDGET)
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let consecutiveDead = 0
  let unknownSinceMs: number | null = null

  const fire = (reason: WatchdogReason, detail: object): void => {
    disposed = true
    log.warn({ kind: handle.kind, id: handle.id, reason, ...detail }, 'Watchdog suelta la sesión')
    try {
      onGone(reason)
    } catch (err) {
      log.error({ err }, 'session-watchdog onGone handler threw')
    }
  }

  const tick = async (): Promise<void> => {
    if (disposed) return
    let state: Liveness
    try {
      state = await handle.liveness()
    } catch (err) {
      // Que la sonda misma explote es un `unknown` más — el adapter debería
      // haberlo traducido, pero no dependemos de su disciplina para no matar
      // un run sano.
      log.debug(
        { kind: handle.kind, id: handle.id, err: (err as Error).message },
        'liveness lanzó — se cuenta como unknown',
      )
      state = 'unknown'
    }
    if (disposed) return

    if (state === 'alive') {
      consecutiveDead = 0
      unknownSinceMs = null
      timer = setTimeout(tick, intervalMs)
      return
    }

    if (state === 'unknown') {
      // `unknown` no toca el contador de muertes: no es media evidencia de
      // muerte, es ausencia de evidencia. Lleva su propio reloj.
      const now = Date.now()
      if (unknownSinceMs == null) unknownSinceMs = now
      const elapsed = now - unknownSinceMs
      if (elapsed < unknownBudgetMs) {
        log.debug(
          { kind: handle.kind, id: handle.id, elapsedMs: elapsed, unknownBudgetMs },
          'Liveness desconocida — sigo esperando, no es evidencia de muerte',
        )
        timer = setTimeout(tick, intervalMs)
        return
      }
      fire('liveness-unknown', { elapsedMs: elapsed, unknownBudgetMs })
      return
    }

    consecutiveDead += 1
    if (consecutiveDead < confirmChecks) {
      log.debug(
        { kind: handle.kind, id: handle.id, consecutiveDead, confirmChecks },
        'Session read as dead — awaiting confirmation before firing onGone',
      )
      timer = setTimeout(tick, intervalMs)
      return
    }
    fire('confirmed-dead', { consecutiveDead })
  }

  timer = setTimeout(tick, graceMs)

  return () => {
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
