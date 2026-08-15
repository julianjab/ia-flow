// Two independent things a freshly built manager may need to do before
// settling into its normal rhythm. They were one flag once, which was wrong:
// they answer different questions.
//
// · `crashRecovery` — `source.onDaemonStart()`, which clears `working` flags
//   left behind by a killed run. Correct **only on a real process boot**. On
//   `reloadManagers()` (a project edit, an env-var save, a mode switch) the
//   daemon never went down, so clearing those flags would strip the marker off
//   runs that are still in flight and let the next scan dispatch a second agent
//   for the same task.
//
// · `initialScan` — one immediate cycle. Correct on boot *and* whenever the
//   manager itself is new: a project just created, or one just switched to
//   webhook mode, has never been scanned by this manager. In webhook mode
//   nothing else would look at it until a delivery arrives — and with no
//   fallback timer (the default) that may be never.
//
// IA_FLOW_STARTUP_SCAN=0 suppresses the **boot** pass only. Dev runs
// `bun --watch`, so every file save restarts the process and would otherwise
// re-dispatch every task sitting in a configured status. It must not suppress
// a new manager's first scan, which no restart is going to repeat.

export interface CatchUpOptions {
  /** Run `source.onDaemonStart()` before the first cycle. Boot only. */
  crashRecovery?: boolean
  /** Run one cycle on start(). */
  initialScan?: boolean
}

/** Boot-time catch-up toggle (IA_FLOW_STARTUP_SCAN, default on). Read lazily. */
export function startupScanEnabled(): boolean {
  const raw = process.env.IA_FLOW_STARTUP_SCAN?.trim().toLowerCase()
  if (raw === undefined || raw === '') return true
  return !['0', 'false', 'no', 'off'].includes(raw)
}

/**
 * Resolve both flags for one manager.
 *
 * @param boot  true when the daemon process is starting, false on reload.
 * @param isNew true when this manager didn't exist in the previous generation.
 */
export function resolveCatchUp(boot: boolean, isNew: boolean): Required<CatchUpOptions> {
  if (boot) {
    const on = startupScanEnabled()
    return { crashRecovery: on, initialScan: on }
  }
  return { crashRecovery: false, initialScan: isNew }
}
