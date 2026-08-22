import type { FailureClass } from '@ia-flow/shared'

// Turns one run's raw signals into a class you can GROUP BY.
//
// `outcome` already answers "did it work". This answers "what broke", which
// is the question that decides whether the fix is a prompt, a missing tool, a
// permission, or infrastructure — and it's the column the health panel and
// the retro agent aggregate on. Free-text `errorMsg` can't do that job: two
// runs that failed the same way rarely produce the same string.
//
// Pure on purpose: no I/O, no clock, no DB. Every input is something the
// orchestrator already holds when a run finishes, so this stays testable
// against a table of fixtures instead of a live agent.

export interface ClassifyFailureInput {
  outcome: 'success' | 'error' | 'cancelled' | 'truncated' | null
  /** Model stop_reason, when the provider reported one. */
  stopReason?: string | null
  /** Error text from the thrown exception, when the run crashed. */
  errorMsg?: string | null
  /** Tool counters, when measurable. `null`/undefined = not measured (an
   *  async run without hooks), which is NOT the same as zero and must never
   *  be read as "did nothing". */
  toolCalls?: number | null
  toolErrors?: number | null
  /** How many tools the agent was configured with. Only used to decide
   *  whether zero tool calls is suspicious: an agent with no tools that
   *  writes a comment did its whole job without calling anything. */
  toolsAvailable?: number | null
}

// A run is only called out for tool failures once there's enough of a sample
// for the ratio to mean something — one failed call out of one is routinely
// just the agent probing (a file that doesn't exist yet, a grep with no hits).
const MIN_TOOL_CALLS_FOR_RATIO = 3
const TOOL_ERROR_RATIO = 0.5

// Substrings that identify a failure as environmental rather than the
// agent's doing. Matched case-insensitively against errorMsg. Deliberately
// narrow: a wrong `infra_error` sends someone to debug the network when the
// prompt was the problem, so anything unrecognised stays `unknown`.
const INFRA_PATTERNS = [
  'git clone failed',
  'git fetch',
  'git worktree add',
  'git status --porcelain failed',
  'enotfound',
  'econnrefused',
  'econnreset',
  'etimedout',
  'socket hang up',
  'fetch failed',
  'rate limit',
  'no space left on device',
  'permission denied',
  'authentication failed',
]

function classifyStopReason(stopReason: string | null | undefined): FailureClass {
  switch (stopReason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'budget_exhausted'
    case 'hard_iter_cap':
      return 'iteration_cap'
    case 'pause_turn':
      return 'server_tool_pause'
    case 'refusal':
      return 'refusal'
    default:
      return 'unknown'
  }
}

function looksLikeInfra(errorMsg: string | null | undefined): boolean {
  if (!errorMsg) return false
  const lower = errorMsg.toLowerCase()
  return INFRA_PATTERNS.some((p) => lower.includes(p))
}

function toolErrorRatioTripped(input: ClassifyFailureInput): boolean {
  const calls = input.toolCalls
  const errors = input.toolErrors
  if (typeof calls !== 'number' || typeof errors !== 'number') return false
  if (calls < MIN_TOOL_CALLS_FOR_RATIO) return false
  return errors / calls >= TOOL_ERROR_RATIO
}

/**
 * Returns the failure class for a finished run, or `null` when the run
 * succeeded and there's nothing to explain. A run still in flight
 * (`outcome: null`) is also `null` — it hasn't failed yet.
 */
export function classifyFailure(input: ClassifyFailureInput): FailureClass | null {
  switch (input.outcome) {
    case null:
    case undefined:
      return null

    case 'cancelled':
      return 'cancelled'

    case 'truncated':
      return classifyStopReason(input.stopReason)

    case 'error':
      // A crash whose message names an environmental cause is infra even if
      // tools were also failing — the tool errors are usually downstream of
      // the same broken workspace.
      if (looksLikeInfra(input.errorMsg)) return 'infra_error'
      if (toolErrorRatioTripped(input)) return 'tool_failure'
      return 'unknown'

    case 'success': {
      // A "successful" run that never called a tool, while having tools it
      // could have called, moved the task forward without doing any work —
      // the failure mode that a success-rate metric alone rewards. Only
      // claimed when tool calls were actually measured.
      const calls = input.toolCalls
      const available = input.toolsAvailable
      if (
        typeof calls === 'number' &&
        calls === 0 &&
        typeof available === 'number' &&
        available > 0
      )
        return 'no_op'
      // Succeeded, but most of its tool calls errored on the way — worth
      // surfacing: usually a missing permission the agent worked around.
      if (toolErrorRatioTripped(input)) return 'tool_failure'
      return null
    }

    default:
      return 'unknown'
  }
}
