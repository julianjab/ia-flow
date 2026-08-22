// Tool telemetry for runs this process can't instrument directly.
//
// Sync (`anthropic-api`) runs get their counters straight from `executeLoop`,
// which sees every tool call. Async/terminal runs (tmux, iterm, claude-print)
// don't: the model executes inside a Claude Code session, and the only thing
// that crosses back is the hook forwarder posting to `/api/hook-events`. This
// registry is where those hook events are tallied so `Agent.ts` can attach a
// tool-call count to the execution log of a terminal run — the same shape a
// sync run reports, minus token usage (hooks carry no `usage` block).
//
// Keyed by `runId`, which the hook script reads from `IA_FLOW_RUN_ID` and the
// orchestrator already stamps on the execution log.

export interface RunToolTelemetry {
  toolCalls: number
  /** Tool results the hook explicitly flagged as failures. Never inferred —
   *  see `detectToolError` in packages/ai-providers/src/terminal/hook-tool-use.ts. */
  toolErrors: number
}

interface Entry extends RunToolTelemetry {
  touchedAt: number
}

// A run whose agent crashes before `take` leaks its entry. Bounded two ways:
// entries older than the TTL are dropped on every write, and the map is
// hard-capped so a burst can't grow it without bound between sweeps.
const TTL_MS = 6 * 60 * 60_000
const MAX_ENTRIES = 500

const entries = new Map<string, Entry>()

function sweep(now: number): void {
  for (const [runId, entry] of entries) {
    if (now - entry.touchedAt > TTL_MS) entries.delete(runId)
  }
  // Still over cap after the TTL pass (many concurrent live runs): evict the
  // least recently touched. Losing a counter degrades a metric, never a run.
  if (entries.size > MAX_ENTRIES) {
    const oldestFirst = [...entries.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)
    for (const [runId] of oldestFirst.slice(0, entries.size - MAX_ENTRIES)) {
      entries.delete(runId)
    }
  }
}

/** Records one tool result reported by a Claude Code hook. `isError`
 *  undefined means the hook couldn't tell — counted as a call, not an error. */
export function recordHookToolResult(runId: string, isError?: boolean): void {
  if (!runId) return
  const now = Date.now()
  const entry = entries.get(runId) ?? { toolCalls: 0, toolErrors: 0, touchedAt: now }
  entry.toolCalls++
  if (isError === true) entry.toolErrors++
  entry.touchedAt = now
  entries.set(runId, entry)
  sweep(now)
}

/** Reads the tally without consuming it — for a run still in flight. */
export function peekRunTelemetry(runId: string): RunToolTelemetry | undefined {
  const entry = entries.get(runId)
  return entry ? { toolCalls: entry.toolCalls, toolErrors: entry.toolErrors } : undefined
}

/** Reads and drops the tally. Called once when a run finishes. Returns
 *  undefined when no hook ever fired for this run — which is the normal case
 *  for a sync run, and for a terminal run whose session had no hooks wired. */
export function takeRunTelemetry(runId: string): RunToolTelemetry | undefined {
  const result = peekRunTelemetry(runId)
  entries.delete(runId)
  return result
}

/** Test seam — drops every tally. */
export function resetRunTelemetry(): void {
  entries.clear()
}
