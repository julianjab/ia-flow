// Thin wrappers around IExecutionLogRepository writes. The repo is optional
// (tests build the orchestrator without one) and every call site already
// swallowed insert/update failures with the same log.warn — consolidated
// here so AgentOrchestrator's per-agent lifecycle doesn't repeat the
// try/catch ten times over.
import { createHash } from 'node:crypto'
import type { RunMetrics } from '@ia-flow/ai-providers'
import type { ExecutionLog } from '@ia-flow/shared'
import type { IExecutionLogRepository } from './contract.js'
import { classifyFailure } from './failure-taxonomy.js'
import { createLogger } from './logger.js'
import { takeRunTelemetry } from './run-telemetry.js'

const log = createLogger('execution-log')

export function safeInsertLog(
  repo: IExecutionLogRepository | undefined,
  entry: ExecutionLog,
): void {
  try {
    repo?.insert(entry)
  } catch (err) {
    log.warn({ err }, 'Failed to insert execution log')
  }
}

export function safeUpdateLog(
  repo: IExecutionLogRepository | undefined,
  id: string,
  patch: Partial<ExecutionLog>,
): void {
  try {
    repo?.update(id, patch)
  } catch (err) {
    log.warn({ err }, 'Failed to update execution log')
  }
}

/**
 * Identity of the prompt a run actually executed — the resolved prompt plus
 * the system blocks, hashed together. Two runs of "the same" agent are only
 * comparable when this matches, so it's what lets a regression be pinned to
 * a specific prompt edit rather than to the agent id in the abstract.
 *
 * Truncated to 12 hex chars: this is a grouping key for a few thousand rows,
 * not a security primitive, and a short one stays readable in the UI.
 */
export function hashPrompt(...parts: Array<string | undefined | null>): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part ?? '')
  return hash.digest('hex').slice(0, 12)
}

export interface FinishPatchInput {
  outcome: NonNullable<ExecutionLog['outcome']>
  stopReason?: string | null
  errorMsg?: string | null
  /** Wall-clock start, from `Date.now()` at dispatch. */
  startedAtMs: number
  /** Correlates with daemon.log and /api/hook-events. Also the key the hook
   *  tally is read back under for async runs. */
  runId: string
  /** Set by sync providers (`anthropic-api`). Undefined for async/terminal
   *  runs, whose counters come from the hook tally instead — and whose token
   *  usage is simply not observable from this process. */
  metrics?: RunMetrics
  /** How many tools the agent was configured with — lets `classifyFailure`
   *  tell "did nothing" from "had nothing to do". */
  toolsAvailable?: number
  agentPromptHash?: string
}

/**
 * Builds the telemetry half of a finishing execution-log update. Kept here
 * rather than inlined at each of Agent.ts's several finish branches so every
 * one of them records the same fields — a branch that forgets a column is a
 * silent hole in the metric, and the branches that finish a run are exactly
 * the interesting ones (truncated, cancelled, errored).
 */
export function buildFinishPatch(input: FinishPatchInput): Partial<ExecutionLog> {
  // Sync providers measured everything themselves. For async runs the only
  // observer was the Claude Code hook forwarder, which counts tool calls but
  // never sees token usage — so those stay null, meaning "not measurable
  // here" rather than zero.
  const hookTally = input.metrics ? undefined : takeRunTelemetry(input.runId)
  const toolCalls = input.metrics?.toolCalls ?? hookTally?.toolCalls ?? null
  const toolErrors = input.metrics?.toolErrors ?? hookTally?.toolErrors ?? null

  return {
    durationMs: Date.now() - input.startedAtMs,
    runId: input.runId,
    agentPromptHash: input.agentPromptHash ?? null,
    tokensIn: input.metrics?.usage.inputTokens ?? null,
    tokensOut: input.metrics?.usage.outputTokens ?? null,
    cacheReadTokens: input.metrics?.usage.cacheReadTokens ?? null,
    cacheCreationTokens: input.metrics?.usage.cacheCreationTokens ?? null,
    iters: input.metrics?.iters ?? null,
    toolCalls,
    toolErrors,
    failureClass: classifyFailure({
      outcome: input.outcome,
      stopReason: input.stopReason,
      errorMsg: input.errorMsg,
      toolCalls,
      toolErrors,
      toolsAvailable: input.toolsAvailable,
    }),
  }
}
