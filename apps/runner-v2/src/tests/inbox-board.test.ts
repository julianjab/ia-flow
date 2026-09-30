import { describe, expect, it } from 'bun:test'
import { createEvent } from '@ia-flow/agent-engine'
import { toBoardCard, toBoardMeta } from '../inbox/BoardReader.js'
import { summarizeEvent } from '../inbox/eventSummary.js'
import { InboxSection } from '../inbox/InboxSection.js'
import { TaskActions } from '../tasks/TaskActions.js'

const item = (content: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({
  id: 'PVTI_1',
  updatedAt: '2026-09-29T10:00:00Z',
  fieldValues: {
    nodes: [
      { name: 'Build', field: { name: 'Status' } },
      { name: 'Technical', field: { name: 'Task Type' } },
    ],
  },
  content: {
    number: 7,
    title: 'Una tarea',
    url: 'https://github.com/la-haus/subs/issues/7',
    state: 'OPEN',
    repository: { name: 'subs', owner: { login: 'la-haus' } },
    labels: { nodes: [{ name: 'blocked' }] },
    ...content,
  },
  ...patch,
})

describe('toBoardCard', () => {
  it('reads status, type, labels, open blockers and the open PR that closes it', () => {
    const card = toBoardCard(
      item({
        closedByPullRequestsReferences: {
          nodes: [
            {
              number: 3,
              state: 'MERGED',
              repository: { name: 'subs', owner: { login: 'la-haus' } },
            },
            {
              number: 4,
              state: 'OPEN',
              url: 'pr-url',
              repository: { name: 'subs', owner: { login: 'la-haus' } },
            },
          ],
        },
        blockedBy: {
          nodes: [
            { number: 2, state: 'OPEN', repository: { name: 'subs', owner: { login: 'la-haus' } } },
            {
              number: 1,
              state: 'CLOSED',
              repository: { name: 'subs', owner: { login: 'la-haus' } },
            },
          ],
        },
      }),
      { projectId: 'p', board: { owner: 'la-haus', number: 119 } },
    )
    expect(card).toEqual({
      ref: 'la-haus/subs#7',
      itemId: 'PVTI_1',
      projectId: 'p',
      title: 'Una tarea',
      url: 'https://github.com/la-haus/subs/issues/7',
      status: 'Build',
      taskType: 'Technical',
      labels: ['blocked'],
      updatedAt: '2026-09-29T10:00:00Z',
      blockedBy: ['la-haus/subs#2'],
      pr: { number: 4, url: 'pr-url' },
    })
  })

  it('skips closed issues and archived items; marks the cards of another engine', () => {
    const spec = { projectId: 'p', board: { owner: 'la-haus', number: 119 } }
    expect(toBoardCard(item({ state: 'CLOSED' }), spec)).toBeUndefined()
    expect(toBoardCard(item({}, { isArchived: true }), spec)).toBeUndefined()
    // Sin la label del proyecto no se descarta: es de otro engine.
    expect(toBoardCard(item({}), { ...spec, label: 'ia-flow' })).toMatchObject({ foreign: true })
    expect(toBoardCard(item({}), { ...spec, label: 'blocked' })?.foreign).toBeUndefined()
  })
})

describe('summarizeEvent', () => {
  it('keeps what explains the event: field, from→to, author and a comment excerpt', () => {
    const raw = createEvent('github.projects_v2_item', {
      action: 'edited',
      changes: {
        field_value: { field_name: 'Status', from: { name: 'Refine' }, to: { name: 'Build' } },
      },
      sender: { login: 'julian' },
    })
    expect(summarizeEvent(raw, 140)).toEqual({
      action: 'edited',
      field: 'Status',
      from: 'Refine',
      to: 'Build',
      author: 'julian',
    })
    const comment = createEvent(
      'issue_comment',
      { body: `${'a'.repeat(200)}`, author: 'ana' },
      { scope: { issue: 'o/r#1' } },
    )
    const summary = summarizeEvent(comment, 20)
    expect(summary.comment).toHaveLength(20)
    expect(summary).toMatchObject({ author: 'ana', issue: 'o/r#1' })
    expect(summarizeEvent(comment, 0).comment).toBeUndefined()
  })
})

describe('toBoardMeta', () => {
  const board = { owner: 'la-haus', number: 119 }
  it('the project page, its first board view and the Status columns in order', () => {
    const meta = toBoardMeta(
      {
        organization: {
          projectV2: {
            url: 'https://github.com/orgs/la-haus/projects/119',
            views: {
              nodes: [
                { number: 1, layout: 'TABLE_LAYOUT' },
                { number: 3, layout: 'BOARD_LAYOUT' },
              ],
            },
            field: { options: [{ name: 'Backlog' }, { name: 'Review' }] },
          },
        },
      },
      board,
    )
    expect(meta).toEqual({
      url: 'https://github.com/orgs/la-haus/projects/119',
      boardUrl: 'https://github.com/orgs/la-haus/projects/119/views/3',
      statuses: ['Backlog', 'Review'],
    })
  })

  it('without an answer, the links that can be built and no column order', () => {
    expect(toBoardMeta({}, board)).toEqual({
      url: 'https://github.com/orgs/la-haus/projects/119',
      boardUrl: 'https://github.com/orgs/la-haus/projects/119',
      statuses: [],
    })
  })
})

describe('TaskActions', () => {
  it('answer and unblock comments as the user and takes the blocked label off', async () => {
    const calls: string[] = []
    const actions = new TaskActions({
      inbox: {
        item: async () => ({
          ref: 'o/r#1',
          project_id: 'p',
          title: 't',
          url: 'u',
          group: 'need',
          kind: 'doubt',
          labels: ['blocked'],
          why: 'duda',
          since: '',
          actions: ['answer_and_unblock'],
        }),
      },
      boards: new Map(),
      settings: InboxSection.parse({}),
      redispatch: async () => 'ok',
      rerunReview: async () => 'ok',
      stop: () => 'ok',
      changed: () => {},
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
        return Response.json(
          String(input).endsWith('/repos/o/r') ? { permissions: { push: true } } : {},
        )
      }) as typeof fetch,
    })
    await expect(
      actions.run('o/r#1', { action: 'answer_and_unblock' }, { token: 't', login: 'julian' }),
    ).rejects.toThrow(/comentario/)
    const done = await actions.run(
      'o/r#1',
      { action: 'answer_and_unblock', comment: 'Sólo upgrades.' },
      { token: 't', login: 'julian' },
    )
    expect(done).toMatchObject({ ok: true, github_login: 'julian' })
    expect(calls).toEqual([
      'GET https://api.github.com/repos/o/r',
      'POST https://api.github.com/repos/o/r/issues/1/comments',
      'DELETE https://api.github.com/repos/o/r/issues/1/labels/blocked',
    ])
  })

  it('never takes off the blocked label when it is the label that marks the project', async () => {
    const calls: string[] = []
    const actions = new TaskActions({
      inbox: {
        item: async () => ({
          ref: 'o/r#1',
          project_id: 'p',
          title: 't',
          url: 'u',
          group: 'need',
          kind: 'doubt',
          labels: ['blocked'],
          why: 'duda',
          since: '',
          actions: ['answer_and_unblock'],
        }),
      },
      boards: new Map(),
      projectLabels: new Map([['p', 'blocked']]),
      settings: InboxSection.parse({}),
      redispatch: async () => 'ok',
      rerunReview: async () => 'ok',
      stop: () => 'ok',
      changed: () => {},
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
        return Response.json(
          String(input).endsWith('/repos/o/r') ? { permissions: { push: true } } : {},
        )
      }) as typeof fetch,
    })
    const done = await actions.run(
      'o/r#1',
      { action: 'answer_and_unblock', comment: 'Sólo upgrades.' },
      { token: 't', login: 'julian' },
    )
    expect(done.message).toBe('comentado')
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false)
  })
})
