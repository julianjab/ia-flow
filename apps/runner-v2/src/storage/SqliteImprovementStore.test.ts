import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import type { NewImprovement } from '../assistant/ImprovementStore.js'
import { SqliteImprovementStore } from './SqliteImprovementStore.js'

function storeAt(times: string[]) {
  let i = 0
  return new SqliteImprovementStore(
    new Database(':memory:'),
    () => new Date(times[i++] ?? (times.at(-1) as string)),
  )
}

const proposal = (over: Partial<NewImprovement> = {}): NewImprovement => ({
  task_ref: 'o/r#1',
  pr_url: 'https://github.com/o/r/pull/9',
  agent: 'retrospective',
  execution_id: 'exec-1',
  target: 'docs',
  repo: 'o/r',
  title: 'Documentar el comando de lint',
  body: '## Problema\nNo lo encontró.',
  reason: 'el implementer corrió tres comandos equivocados',
  ...over,
})

describe('SqliteImprovementStore', () => {
  it('keeps a proposal open, with what it came from', () => {
    const store = storeAt(['2026-10-01T10:00:00Z'])
    const added = store.add(proposal({ labels: ['docs'] }))
    expect(added).toEqual({
      id: added.id,
      created_at: '2026-10-01T10:00:00.000Z',
      task_ref: 'o/r#1',
      pr_url: 'https://github.com/o/r/pull/9',
      agent: 'retrospective',
      execution_id: 'exec-1',
      target: 'docs',
      repo: 'o/r',
      title: 'Documentar el comando de lint',
      body: '## Problema\nNo lo encontró.',
      labels: ['docs'],
      reason: 'el implementer corrió tres comandos equivocados',
      status: 'open',
    })
    expect(store.get(added.id)).toEqual(added)
  })

  it('omits what it does not have', () => {
    const added = storeAt(['2026-10-01T10:00:00Z']).add(
      proposal({ pr_url: undefined, execution_id: undefined }),
    )
    expect(added).not.toHaveProperty('pr_url')
    expect(added).not.toHaveProperty('execution_id')
    expect(added).not.toHaveProperty('labels')
  })

  it('lists newest first, by status when asked', () => {
    const store = storeAt(['2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z'])
    const first = store.add(proposal({ title: 'a' }))
    const second = store.add(proposal({ title: 'b' }))
    store.decide(first.id, { status: 'dismissed', by: 'julian' })
    expect(store.list().map((p) => p.title)).toEqual(['b', 'a'])
    expect(store.list('open').map((p) => p.id)).toEqual([second.id])
    expect(store.list('dismissed').map((p) => p.id)).toEqual([first.id])
  })

  it('finds an open one with the same title in the same repo, ignoring case', () => {
    const store = storeAt(['2026-10-01T10:00:00Z'])
    const added = store.add(proposal())
    expect(store.findOpen('O/R', '  documentar el comando de LINT ')?.id).toBe(added.id)
    expect(store.findOpen('o/otro', added.title)).toBeUndefined()
    store.decide(added.id, { status: 'dismissed', by: 'julian' })
    expect(store.findOpen('o/r', added.title)).toBeUndefined()
  })

  it('decides an open one once: opened with its issue, by whom and when', () => {
    const store = storeAt(['2026-10-01T10:00:00Z', '2026-10-02T09:00:00Z'])
    const added = store.add(proposal())
    const opened = store.decide(added.id, {
      status: 'opened',
      by: 'julian',
      issue_url: 'https://github.com/o/r/issues/12',
    })
    expect(opened).toMatchObject({
      status: 'opened',
      issue_url: 'https://github.com/o/r/issues/12',
      decided_by: 'julian',
      decided_at: '2026-10-02T09:00:00.000Z',
    })
    expect(store.decide(added.id, { status: 'dismissed', by: 'otra' })).toBeUndefined()
    expect(store.decide('no-existe', { status: 'dismissed', by: 'otra' })).toBeUndefined()
  })

  it('prune drops the decided ones before the cutoff and keeps the open ones', () => {
    const store = storeAt([
      '2026-06-01T00:00:00Z',
      '2026-06-01T00:00:00Z',
      '2026-06-02T00:00:00Z',
      '2026-09-30T00:00:00Z',
    ])
    const old = store.add(proposal({ title: 'vieja' }))
    const pending = store.add(proposal({ title: 'pendiente' }))
    store.decide(old.id, { status: 'dismissed', by: 'julian' })
    const recent = store.add(proposal({ title: 'reciente' }))
    store.decide(recent.id, { status: 'dismissed', by: 'julian' })
    store.prune('2026-09-01T00:00:00Z')
    expect(
      store
        .list()
        .map((p) => p.id)
        .sort(),
    ).toEqual([pending.id, recent.id].sort())
  })

  it('tells its listeners about every add and decision', () => {
    const store = storeAt(['2026-10-01T10:00:00Z'])
    let changes = 0
    const stop = store.onChange(() => changes++)
    store.onChange(() => {
      throw new Error('un listener roto no corta la escritura')
    })
    const added = store.add(proposal())
    store.decide(added.id, { status: 'dismissed', by: 'julian' })
    store.decide(added.id, { status: 'dismissed', by: 'julian' })
    expect(changes).toBe(2)
    stop()
    store.add(proposal({ title: 'otra' }))
    expect(changes).toBe(2)
  })
})
