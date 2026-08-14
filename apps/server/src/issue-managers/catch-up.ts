// Whether a freshly built manager should do a catch-up pass — crash recovery
// (`source.onDaemonStart()`) plus one immediate scan cycle — before settling
// into its normal rhythm.
//
// It's the right thing on a real process boot: whatever moved while the daemon
// was down produced no webhook we could receive, and stuck `working` flags from
// a killed run need clearing.
//
// It is NOT right on `reloadManagers()` (a project edit, an env-var save). The
// daemon never went down, so nothing was missed — and worse, `onDaemonStart()`
// clears the `working` flag of runs that are still in flight, which lets the
// next cycle dispatch a second agent for the same task.
//
// Dev amplifies this: `bun run dev` uses `--watch`, so every file save restarts
// the process and re-dispatches every task sitting in a configured status. Set
// IA_FLOW_STARTUP_SCAN=0 to suppress the boot pass and rely on webhooks alone.

export interface CatchUpOptions {
  /** Run crash recovery + one immediate cycle on start(). */
  catchUp?: boolean
}

/** Boot-time catch-up toggle (IA_FLOW_STARTUP_SCAN, default on). Read lazily. */
export function startupScanEnabled(): boolean {
  const raw = process.env.IA_FLOW_STARTUP_SCAN?.trim().toLowerCase()
  if (raw === undefined || raw === '') return true
  return !['0', 'false', 'no', 'off'].includes(raw)
}
