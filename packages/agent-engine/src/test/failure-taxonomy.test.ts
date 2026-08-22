import { describe, expect, it } from 'bun:test'
import { classifyFailure } from '../failure-taxonomy.js'

describe('classifyFailure — nothing to explain', () => {
  it('returns null for a clean success', () => {
    expect(
      classifyFailure({ outcome: 'success', toolCalls: 12, toolErrors: 0, toolsAvailable: 5 }),
    ).toBeNull()
  })

  it('returns null for a run still in flight', () => {
    expect(classifyFailure({ outcome: null })).toBeNull()
  })
})

describe('classifyFailure — truncation maps to the stop reason', () => {
  const cases: Array<[string, string]> = [
    ['max_tokens', 'budget_exhausted'],
    ['model_context_window_exceeded', 'budget_exhausted'],
    ['hard_iter_cap', 'iteration_cap'],
    ['pause_turn', 'server_tool_pause'],
    ['refusal', 'refusal'],
  ]
  for (const [stopReason, expected] of cases) {
    it(`maps ${stopReason} → ${expected}`, () => {
      expect(classifyFailure({ outcome: 'truncated', stopReason })).toBe(expected as never)
    })
  }

  it('falls back to unknown for an unrecognised stop reason', () => {
    expect(classifyFailure({ outcome: 'truncated', stopReason: 'something_new' })).toBe('unknown')
  })
})

describe('classifyFailure — errors', () => {
  it('recognises an environmental failure from the error message', () => {
    expect(
      classifyFailure({ outcome: 'error', errorMsg: 'git clone failed for repo: ECONNRESET' }),
    ).toBe('infra_error')
  })

  it('matches infra patterns case-insensitively', () => {
    expect(classifyFailure({ outcome: 'error', errorMsg: 'FETCH FAILED' })).toBe('infra_error')
  })

  it('prefers infra over tool_failure when both signals are present', () => {
    expect(
      classifyFailure({
        outcome: 'error',
        errorMsg: 'git fetch origin failed',
        toolCalls: 10,
        toolErrors: 9,
      }),
    ).toBe('infra_error')
  })

  it('flags tool_failure when most tool calls errored', () => {
    expect(classifyFailure({ outcome: 'error', toolCalls: 8, toolErrors: 6 })).toBe('tool_failure')
  })

  it('does not flag tool_failure below the sample threshold', () => {
    expect(classifyFailure({ outcome: 'error', toolCalls: 2, toolErrors: 2 })).toBe('unknown')
  })

  it('does not flag tool_failure when counters were never measured', () => {
    expect(classifyFailure({ outcome: 'error', toolCalls: null, toolErrors: null })).toBe('unknown')
  })

  it('falls back to unknown for an unrecognised error', () => {
    expect(classifyFailure({ outcome: 'error', errorMsg: 'weird explosion' })).toBe('unknown')
  })
})

describe('classifyFailure — cancellation', () => {
  it('reports cancelled regardless of other signals', () => {
    expect(classifyFailure({ outcome: 'cancelled', stopReason: 'max_tokens' })).toBe('cancelled')
  })
})

describe('classifyFailure — no_op', () => {
  it('flags a success that never called a tool it had available', () => {
    expect(classifyFailure({ outcome: 'success', toolCalls: 0, toolsAvailable: 4 })).toBe('no_op')
  })

  it('does not flag an agent that had no tools to call', () => {
    expect(classifyFailure({ outcome: 'success', toolCalls: 0, toolsAvailable: 0 })).toBeNull()
  })

  it('does not guess when tool calls were never measured', () => {
    expect(classifyFailure({ outcome: 'success', toolCalls: null, toolsAvailable: 4 })).toBeNull()
  })

  it('flags a success whose tool calls mostly errored', () => {
    expect(
      classifyFailure({ outcome: 'success', toolCalls: 6, toolErrors: 5, toolsAvailable: 3 }),
    ).toBe('tool_failure')
  })
})
