import { describe, expect, it } from 'bun:test'
import type { InboxItem } from '@ia-flow/shared'
import { prioritize } from './prioritize.js'

const item = (ref: string, patch: Partial<InboxItem>): InboxItem => ({
  ref,
  project_id: 'p',
  title: ref,
  url: 'u',
  group: 'need',
  kind: 'prd',
  labels: [],
  why: 'por qué',
  since: '2026-09-29T10:00:00Z',
  actions: [],
  ...patch,
})

const failure = (by: 'agent' | 'runtime') => ({
  id: `e-${by}`,
  pipeline_id: 'build',
  status: 'failed' as const,
  started_at: '2026-09-29T09:00:00Z',
  failure: { by, message: 'x' },
})

const refs = (items: InboxItem[]) => items.map((each) => each.ref)

describe('prioritize', () => {
  it('1. nearness to Done: merge, review, prd, doubt, crash, stale', () => {
    const result = prioritize([
      item('stale', { kind: 'stale' }),
      item('crash', { group: 'fail', kind: 'crash' }),
      item('doubt', { kind: 'doubt' }),
      item('prd', { kind: 'prd' }),
      item('review', { kind: 'review' }),
      item('merge', { kind: 'merge' }),
    ])
    expect(refs(result)).toEqual(['merge', 'review', 'prd', 'doubt', 'crash', 'stale'])
    expect(result.map((each) => each.priority)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('a crash goes before a stale one even when the stale one is older', () => {
    const result = prioritize([
      item('stale', { kind: 'stale', since: '2026-01-01T00:00:00Z' }),
      item('crash', { group: 'fail', kind: 'crash' }),
    ])
    expect(refs(result)).toEqual(['crash', 'stale'])
  })

  it('2. at the same nearness, what unlocks more goes first', () => {
    const result = prioritize([
      item('none', { since: '2026-01-01T00:00:00Z' }),
      item('two', { unlocks: 2 }),
      item('one', { unlocks: 1 }),
    ])
    expect(refs(result)).toEqual(['two', 'one', 'none'])
    expect(result[0]?.reasons).toContain('destraba 2 tareas')
    expect(result[1]?.reasons).toContain('destraba 1 tarea')
  })

  it('3. at the same weight, a runner failure before an agent failure', () => {
    const result = prioritize([
      item('agent', {
        group: 'fail',
        kind: 'crash',
        execution: failure('agent'),
        since: '2026-01-01T00:00:00Z',
      }),
      item('runtime', { group: 'fail', kind: 'crash', execution: failure('runtime') }),
    ])
    expect(refs(result)).toEqual(['runtime', 'agent'])
    expect(result[0]?.reasons).toEqual(['falló el runner, no el agente'])
    expect(result[1]?.reasons).toEqual(['falló el agente'])
  })

  it('a failure with no known culprit does not blame the runner and goes after a runner one', () => {
    const { failure: _failure, ...noCulprit } = failure('agent')
    const result = prioritize([
      item('unknown', {
        group: 'fail',
        kind: 'crash',
        execution: { ...noCulprit, id: 'e-unknown' },
        since: '2026-01-01T00:00:00Z',
      }),
      item('blocked', {
        group: 'fail',
        kind: 'crash',
        why: 'Bloqueada sin una corrida',
        since: '2026-01-02T00:00:00Z',
      }),
      item('runtime', { group: 'fail', kind: 'crash', execution: failure('runtime') }),
    ])
    expect(refs(result)).toEqual(['runtime', 'unknown', 'blocked'])
    expect(result[1]?.reasons).toEqual(['falló la última corrida'])
    expect(result[2]?.reasons).toEqual(['Bloqueada sin una corrida'])
  })

  it('4. at the same weight, the oldest first', () => {
    const result = prioritize([
      item('new', { since: '2026-09-29T11:00:00Z' }),
      item('old', { since: '2026-09-29T09:00:00Z' }),
    ])
    expect(refs(result)).toEqual(['old', 'new'])
  })

  it('every decision says why, in product terms', () => {
    const [merge] = prioritize([item('merge', { kind: 'merge', unlocks: 2 })])
    expect(merge?.reasons).toEqual(['a un merge de Done', 'destraba 2 tareas'])
  })

  it('what runs or waits its turn goes after, in the usual order and without priority', () => {
    const result = prioritize([
      item('turn', { group: 'queue', kind: 'turn', since: '2026-01-01T00:00:00Z' }),
      item('agent', { group: 'run', kind: 'agent', since: '2026-09-29T11:00:00Z' }),
      item('dep', { group: 'queue', kind: 'dep', since: '2026-02-01T00:00:00Z' }),
      item('stale', { kind: 'stale' }),
    ])
    expect(refs(result)).toEqual(['stale', 'agent', 'turn', 'dep'])
    for (const rest of result.slice(1)) {
      expect(rest.priority).toBeUndefined()
      expect(rest.reasons).toBeUndefined()
    }
  })
})
