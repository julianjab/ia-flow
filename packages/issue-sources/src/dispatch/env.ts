// Shared env-driven knobs for the dispatch layer — pulled out of
// polling-issue-manager.ts/webhook-issue-manager.ts so sources' own watch()
// implementations (github-issues, github-project) can default to the same
// values without depending on files SourceDispatcher is about to replace.
//
// Read lazily (per call), never at import time: env vars stored in the DB
// are pushed into process.env by envRepo.loadIntoProcess(), which runs
// *after* this module is imported. A module-level constant would silently
// ignore anything configured from the UI.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

// `> 0`, not `>= 0` like the rest of this file's knobs: 0 would be a
// tight-loop polling interval, never a valid "off" — unlike debounce/
// fallback, which legitimately mean "off" at 0.
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const pollIntervalMs = (): number => envPositiveInt('IA_FLOW_POLL_INTERVAL_MS', 30_000)

// Bursts are the norm: moving one card on a GitHub Project board (or
// labeling+unlabeling one issue) emits several webhook events within a
// second. Coalesce them into a single scan/emission.
export const webhookDebounceMs = (): number => envInt('IA_FLOW_WEBHOOK_DEBOUNCE_MS', 1_500)

// Optional safety net for dropped deliveries. **Off by default**: webhook
// mode means push only — no periodic pull, no matter how slow. Set
// IA_FLOW_WEBHOOK_FALLBACK_MS to a positive number to opt into a periodic
// scan (e.g. while a hook is misconfigured); anything else keeps it silent.
export const webhookFallbackMs = (): number => envInt('IA_FLOW_WEBHOOK_FALLBACK_MS', 0)

// Cap on concurrently RUNNING agents per project. Counted from the
// pending-task registry — an agent registers there right before its provider
// call (Agent.run) — and deliberately NOT from the items under evaluation.
// An item the dispatch gates reject (blocked by unfinished dependencies, no
// agent matching its status, a degraded source) never starts an agent, so it
// must not hold a slot. Counting evaluations instead let a handful of
// permanently-blocked issues occupy every slot on each scan while the issues
// that could actually run starved behind them, which is a deadlock whenever
// the blockers are exactly those starved issues.
// `envPositiveInt`, not `envInt`: 0 here would mean "never run anything",
// which is a footgun rather than a setting — every item would defer forever
// behind a capacity check that can never clear. Pausing a project is what
// polling-pause.ts is for.
export const maxConcurrentDispatches = (): number =>
  envPositiveInt('IA_FLOW_MAX_CONCURRENT_DISPATCHES', 5)

// Looser, separate bound on how many items are evaluated at once. The run cap
// above ignores evaluations by design, but each one still costs source calls
// (getHealth, getBlockers, loadComments), so a large backlog would otherwise
// fire them all in a single burst. This is a rate guard, not a concurrency
// policy — keep it well above the run cap.
export const maxConcurrentEvaluations = (): number =>
  envPositiveInt('IA_FLOW_MAX_CONCURRENT_EVALUATIONS', 20)

// Ceiling for the concurrency-cap retry backoff — bounds worst-case API
// spend when a backlog structurally never fits under the dispatch cap.
export const concurrencyRetryMaxMs = (): number =>
  envInt('IA_FLOW_CONCURRENCY_RETRY_MAX_MS', 60_000)

// Floor between concurrency-cap retries — not a poll interval (the retry is
// still event-driven), just a guard against a tight loop when slots free
// almost instantly.
export const CONCURRENCY_RETRY_FLOOR_MS = 1_000
