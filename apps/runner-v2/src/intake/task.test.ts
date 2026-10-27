import { describe, expect, it } from 'bun:test'
import { type TaskInput, taskPayload } from './task.js'

const blocker = (repo: string, number: number) => ({
  number,
  title: `t${number}`,
  state: 'open',
  html_url: `https://github.com/la-haus/${repo}/issues/${number}`,
})

const base: TaskInput = {
  emit: 'issue.status_changed',
  owner: 'la-haus',
  repo: 'api',
  number: 5,
  card: { itemId: 'PVTI_5', type: 'technical', status: 'Build' },
  issue: { title: 'B', html_url: 'https://github.com/la-haus/api/issues/5', labels: [] },
  blockers: [blocker('api', 1), blocker('web', 2)],
  projectId: 'p',
  branch: 'feat/b',
  repos: '',
}

const item = (payload: Record<string, unknown>) => payload.item as { blocked: boolean }
const task = (payload: Record<string, unknown>) =>
  payload.task as { blockers: string; stack?: unknown }

describe('taskPayload — stack', () => {
  it('sin stack, cualquier blocker abierto la bloquea', () => {
    const { blocked, payload } = taskPayload(base)
    expect(blocked).toBe(true)
    expect(item(payload).blocked).toBe(true)
    expect(task(payload).stack).toBeUndefined()
  })

  it('apilada, los blockers construidos no la bloquean y la base va en task.stack', () => {
    const stack = {
      pending: [],
      base: { branch: 'feat/a', pr: 10, issue: 'la-haus/api#1' },
    }
    const { blocked, payload } = taskPayload({ ...base, stack })
    expect(blocked).toBe(false)
    expect(item(payload).blocked).toBe(false)
    expect(task(payload).blockers).toBe('')
    expect(task(payload).stack).toEqual(stack.base)
  })

  it('apilada, sólo los pendientes la bloquean y son los que lista task.blockers', () => {
    const { blocked, payload } = taskPayload({ ...base, stack: { pending: ['la-haus/web#2'] } })
    expect(blocked).toBe(true)
    expect(task(payload).blockers).toBe('#2 t2 (https://github.com/la-haus/web/issues/2)')
  })
})

describe('taskPayload — blockersRefined', () => {
  const refined = (payload: Record<string, unknown>) =>
    (payload.item as { blockersRefined?: boolean }).blockersRefined

  it('sin refinedStatuses en el intake, el campo no viaja', () => {
    expect(refined(taskPayload(base).payload)).toBeUndefined()
  })

  it('con el cálculo del intake, viaja en item.blockersRefined junto a item.blocked', () => {
    const { payload } = taskPayload({ ...base, blockersRefined: true })
    expect(refined(payload)).toBe(true)
    expect(item(payload).blocked).toBe(true)
  })
})

describe('taskPayload — news', () => {
  const at = (iso: string, body: string) => ({ created_at: iso, body, user: { login: 'julian' } })
  const taskOf = (payload: Record<string, unknown>) =>
    payload.task as { news?: string; lastRunAt?: string; comments: string }

  it('sin corrida previa, no trae task.news ni task.lastRunAt', () => {
    const { payload } = taskPayload(base)
    expect(taskOf(payload).news).toBeUndefined()
    expect(taskOf(payload).lastRunAt).toBeUndefined()
  })

  it('con lastRunAt, task.news trae sólo lo posterior y task.comments sigue completo', () => {
    const { payload } = taskPayload({
      ...base,
      lastRunAt: '2026-10-27T11:00:00Z',
      issueComments: [at('2026-10-27T10:00:00Z', 'antes'), at('2026-10-27T12:00:00Z', 'después')],
    })
    expect(taskOf(payload).lastRunAt).toBe('2026-10-27T11:00:00Z')
    expect(taskOf(payload).news).toContain('después')
    expect(taskOf(payload).news).not.toContain('antes')
    expect(taskOf(payload).comments).toContain('antes')
  })
})
