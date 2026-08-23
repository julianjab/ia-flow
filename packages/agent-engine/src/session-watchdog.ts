// Shared liveness poller for terminal-backed provider sessions.
//
// Both tmux and iterm providers spawn Claude out-of-process and hand a
// SessionHandle back to the orchestrator. If the user closes the tab (or
// tmux crashes, or the shell exits before Claude finished) the agent will
// never call complete_task / fail_task and the execution row would stay
// `finished_at IS NULL` forever, blocking any downstream task waiting on it.
//
// This module polls `handle.isAlive()` at a fixed interval and fires
// `onDead` once when it flips to false. The orchestrator uses that to cancel
// the pending task and finalize the execution log.

import type { SessionHandle } from '@ia-flow/ai-providers'
import { createLogger } from './logger.js'

const log = createLogger('session-watchdog')

export interface WatchOptions {
  /** How often to poll after the grace period. Default 10s — cheap enough for
   *  AppleScript / `tmux has-session`, high enough to not spam. */
  intervalMs?: number
  /** Delay before the first poll. The session needs a moment to register in
   *  the tmux server / iTerm2's session list; polling immediately would
   *  false-positive as dead. Default 5s. */
  graceMs?: number
  /** Consecutive `isAlive()===false` readings required before firing
   *  `onDead`. A single negative reading can be a transient blip (AppleScript
   *  querying iTerm mid-tab-switch, tmux server hiccup) rather than the
   *  session actually being gone — firing on the first one tears down the
   *  in-memory pending-task entry irreversibly (see pending-tasks.ts) even
   *  though the real terminal session, and the agent inside it, keeps
   *  running. Default 2 — one blip is tolerated, two in a row is treated as
   *  real. */
  confirmChecks?: number
}

const DEFAULT_INTERVAL = 10_000
const DEFAULT_GRACE = 5_000
const DEFAULT_CONFIRM_CHECKS = 2

/**
 * Start polling `handle.isAlive()`; call `onDead` at most once when the
 * session stops responding. Returns an `unwatch` fn that must be called
 * when the run finishes normally (complete_task / fail_task / manual cancel)
 * so the poller doesn't fire against a session we already tore down.
 */
export function watchSession(
  handle: SessionHandle,
  onDead: () => void,
  opts: WatchOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL
  const graceMs = opts.graceMs ?? DEFAULT_GRACE
  const confirmChecks = Math.max(1, opts.confirmChecks ?? DEFAULT_CONFIRM_CHECKS)
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let consecutiveDead = 0

  const tick = async (): Promise<void> => {
    if (disposed) return
    let alive = true
    try {
      alive = await handle.isAlive()
    } catch (err) {
      // Transient AppleScript / tmux hiccup — leave it alive and retry so a
      // flaky check doesn't spuriously kill a healthy run.
      log.debug(
        { kind: handle.kind, id: handle.id, err: (err as Error).message },
        'isAlive check errored — treating as alive',
      )
    }
    if (disposed) return
    if (!alive) {
      consecutiveDead += 1
      if (consecutiveDead < confirmChecks) {
        log.debug(
          { kind: handle.kind, id: handle.id, consecutiveDead, confirmChecks },
          'Session read as dead — awaiting confirmation before firing onDead',
        )
        timer = setTimeout(tick, intervalMs)
        return
      }
      disposed = true
      log.warn(
        { kind: handle.kind, id: handle.id, consecutiveDead },
        'Session no longer alive — firing onDead',
      )
      try {
        onDead()
      } catch (err) {
        log.error({ err }, 'session-watchdog onDead handler threw')
      }
      return
    }
    consecutiveDead = 0
    timer = setTimeout(tick, intervalMs)
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
