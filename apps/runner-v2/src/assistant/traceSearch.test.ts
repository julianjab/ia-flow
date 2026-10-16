import { describe, expect, it } from 'bun:test'
import type { TraceInsight, TraceSearchQuery } from './TraceInsight.js'
import { searchTraces, TRACE_SEARCH_MAX_LIMIT } from './traceSearch.js'

function fake(truncated = false) {
  const queries: TraceSearchQuery[] = []
  const traces = {
    search: (query: TraceSearchQuery) => {
      queries.push(query)
      return {
        executions: [
          { execution_id: 'e1', matches: 2 },
          { execution_id: 'e2', matches: 1 },
        ],
        truncated,
      }
    },
  } as unknown as TraceInsight
  return { traces, queries }
}

describe('searchTraces', () => {
  it('caps the limit, normalizes the dates and keeps the scope the runner imposes', () => {
    const { traces, queries } = fake()
    searchTraces(
      traces,
      { text: ' pause_turn ', since: '2026-10-01', limit: 500, agent_id: 'reviewer' },
      { taskRef: 'o/r#1' },
    )
    expect(queries).toEqual([
      {
        text: 'pause_turn',
        since: '2026-10-01T00:00:00.000Z',
        agentId: 'reviewer',
        taskRef: 'o/r#1',
        limit: TRACE_SEARCH_MAX_LIMIT,
        samples: 3,
      },
    ])
  })

  it('says how many matched and, if there are more, how to narrow it', () => {
    const { traces } = fake(true)
    const result = searchTraces(traces, { text: 'memory' }, {})
    expect(result.note).toContain('2 ejecuciones')
    expect(result.note).toContain('3 entradas')
    expect(result.note).toContain('hay más: acotá')
  })

  it('refuses a too short text, a bad date, or a runner without a database', () => {
    const { traces } = fake()
    expect(() => searchTraces(traces, { text: 'a' }, {})).toThrow(/al menos 2/)
    expect(() => searchTraces(traces, { text: 'ab', until: 'mañana' }, {})).toThrow(/fecha ISO/)
    expect(() => searchTraces(undefined, { text: 'ab' }, {})).toThrow(/no guarda las trazas/)
  })
})
