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
  it('keeps one that does not come from a task, without task_ref', () => {
    const store = storeAt(['2026-10-01T10:00:00Z'])
    const { task_ref: _, pr_url: __, execution_id: ___, ...rest } = proposal({ target: 'config' })
    const added = store.add({ ...rest, agent: 'assistant' })
    expect(added).not.toHaveProperty('task_ref')
    expect(store.get(added.id)).toEqual(added)
  })

  it('migrates a base where task_ref was NOT NULL without losing a row', () => {
    const database = new Database(':memory:')
    database.exec(`
      CREATE TABLE improvement_proposal (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, task_ref TEXT NOT NULL, pr_url TEXT,
        agent TEXT NOT NULL, execution_id TEXT, target TEXT NOT NULL, repo TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, labels_json TEXT NOT NULL, reason TEXT NOT NULL,
        status TEXT NOT NULL, issue_url TEXT, decided_by TEXT, decided_at TEXT
      );
      CREATE INDEX improvement_proposal_status ON improvement_proposal (status, created_at);
      INSERT INTO improvement_proposal VALUES
        ('a', '2026-10-01T10:00:00Z', 'o/r#1', NULL, 'retrospective', 'e1', 'docs', 'o/r',
         'Uno', 'b', '["docs"]', 'r', 'open', NULL, NULL, NULL),
        ('b', '2026-10-01T10:00:00Z', 'o/r#2', 'https://pr', 'retrospective', NULL, 'engine',
         'o/ia-flow', 'Dos', 'b', '[]', 'r', 'opened', 'https://issue', 'julianjab',
         '2026-10-02T10:00:00Z');
    `)
    const store = new SqliteImprovementStore(database)
    expect(store.list().map((item) => [item.id, item.task_ref])).toEqual([
      ['b', 'o/r#2'],
      ['a', 'o/r#1'],
    ])
    expect(store.get('a')).toMatchObject({ labels: ['docs'], execution_id: 'e1', status: 'open' })
    expect(store.get('b')).toMatchObject({ issue_url: 'https://issue', decided_by: 'julianjab' })
    const { task_ref: _, ...rest } = proposal()
    expect(store.add(rest)).not.toHaveProperty('task_ref')
    const indexes = database
      .query<{ name: string }, []>("PRAGMA index_list('improvement_proposal')")
      .all()
      .map((index) => index.name)
    expect(indexes).toContain('improvement_proposal_status')
    // Reabrir la base ya migrada no la vuelve a tocar.
    expect(new SqliteImprovementStore(database).list()).toHaveLength(3)
  })

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

  it('revises only what comes, only while it is open, and tells its listeners', () => {
    const store = storeAt(['2026-10-01T10:00:00Z'])
    const added = store.add(proposal({ labels: ['docs'] }))
    let changes = 0
    store.onChange(() => changes++)

    const revised = store.revise(added.id, { title: 'Otro título', body: '## Problema\nOtro.' })
    expect(revised).toEqual({ ...added, title: 'Otro título', body: '## Problema\nOtro.' })
    expect(store.revise(added.id, { labels: [] })?.labels).toBeUndefined()
    expect(changes).toBe(2)

    store.decide(added.id, { status: 'dismissed', by: 'julianjab' })
    expect(store.revise(added.id, { title: 'tarde' })).toBeUndefined()
    expect(store.revise('no-existe', { title: 'x' })).toBeUndefined()
    expect(store.get(added.id)?.title).toBe('Otro título')
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
