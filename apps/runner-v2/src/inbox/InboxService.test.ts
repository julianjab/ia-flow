import { describe, expect, it } from 'bun:test'
import type { EventLogEntry, ExecutionSummary } from '@ia-flow/shared'
import type { ActivityPort, StoredEvent } from './ActivityPort.js'
import type { BoardMeta } from './BoardReader.js'
import type { BoardCard } from './classify.js'
import { InboxSection } from './InboxSection.js'
import { InboxService } from './InboxService.js'

const now = new Date('2026-09-29T12:00:00Z')
const card = (ref: string, patch: Partial<BoardCard> = {}): BoardCard => ({
  ref,
  projectId: 'p',
  title: ref,
  url: `https://github.com/${ref.replace('#', '/issues/')}`,
  status: 'Build',
  labels: [],
  updatedAt: '2026-09-29T11:00:00Z',
  blockedBy: [],
  ...patch,
})

type Row = ExecutionSummary & { key: string; task_ref?: string }

function fakeActivity(
  rows: Row[] = [],
  events: Record<string, EventLogEntry[]> = {},
  last?: StoredEvent,
): ActivityPort {
  return {
    executions: ({ taskRef, statuses, limit }) =>
      rows
        .filter((row) => !taskRef || row.task_ref === taskRef)
        .filter((row) => !statuses || statuses.includes(row.status))
        .slice(0, limit ?? 50),
    lastEventAt: (ref) => events[ref]?.[0]?.occurred_at,
    eventsForTask: (ref) => events[ref] ?? [],
    recentEvents: () => [],
    trace: () => [],
    lastDispatchedEvent: () => last,
  }
}

function service(
  cards: BoardCard[],
  activity: ActivityPort,
  waiting: string[] = [],
  meta?: BoardMeta,
) {
  const explained: StoredEvent[] = []
  const inbox = new InboxService({
    projects: [{ projectId: 'p', board: { owner: 'la-haus', number: 1 } }],
    board: { cards: async () => cards, ...(meta ? { meta: async () => meta } : {}) },
    activity,
    waitingKeys: () => waiting,
    explain: async (event) => {
      explained.push(event)
      return [
        {
          pipeline_id: 'build-reentry',
          source_id: 'p',
          verdict: 'mismatch',
          reason: 'fieldName notIn […]',
        },
      ]
    },
    settings: InboxSection.parse({}),
    now: () => now,
  })
  return { inbox, explained }
}

describe('InboxService', () => {
  it('classifies the board against the executions, in urgency order, counting what each unblocks', async () => {
    const running: Row = {
      id: 'e1',
      key: '[["issue","o/r#3"],["projectId","p"]]',
      task_ref: 'o/r#3',
      pipeline_id: 'build-arrival',
      status: 'running',
      started_at: '2026-09-29T11:55:00Z',
    }
    const { inbox } = service(
      [
        card('o/r#1', { status: 'Review', labels: ['reviewed'], pr: { number: 9, url: 'u' } }),
        card('o/r#2', { blockedBy: ['o/r#1'] }),
        card('o/r#3'),
        card('o/r#4', { status: 'Todo' }),
        card('o/r#5'),
      ],
      fakeActivity([running]),
      ['[["issue","o/r#5"],["projectId","p"]]'],
    )

    const result = await inbox.inbox()

    expect(result.items.map((item) => `${item.ref}:${item.kind}`)).toEqual([
      'o/r#1:merge',
      'o/r#3:agent',
      'o/r#2:dep',
      'o/r#5:turn',
    ])
    expect(result.items[0]?.unlocks).toBe(1)
    expect(result.items[1]?.execution?.id).toBe('e1')
    // Sin `meta`, el link del Project se arma solo y el del board cae a él.
    const url = 'https://github.com/orgs/la-haus/projects/1'
    expect(result.projects).toEqual([
      { id: 'p', board: { owner: 'la-haus', number: 1 }, url, board_url: url },
    ])
  })

  it('the rest of the board: what the inbox does not show, by column in board order, newest first', async () => {
    const meta: BoardMeta = {
      url: 'https://github.com/orgs/la-haus/projects/1',
      boardUrl: 'https://github.com/orgs/la-haus/projects/1/views/2',
      statuses: ['Backlog', 'Todo', 'Refined', 'Done'],
    }
    const { inbox } = service(
      [
        card('o/r#1', { status: 'Refined' }),
        card('o/r#2', { status: 'Todo', updatedAt: '2026-09-28T00:00:00Z' }),
        card('o/r#3', { status: 'Todo', updatedAt: '2026-09-29T00:00:00Z' }),
        card('o/r#4', { status: 'Backlog' }),
        card('o/r#5', { status: undefined }),
      ],
      fakeActivity(),
      [],
      meta,
    )
    const rest = await inbox.rest()
    // o/r#1 está en la bandeja (PRD para aprobar): no se repite.
    expect(rest.columns.map((c) => [c.status, c.items.map((i) => i.ref)])).toEqual([
      ['Backlog', ['o/r#4']],
      ['Todo', ['o/r#3', 'o/r#2']],
      ['Sin status', ['o/r#5']],
    ])
    expect((await inbox.inbox()).projects[0]).toMatchObject({ board_url: meta.boardUrl })
  })

  it('a task outside the inbox still has a detail, as idle', async () => {
    const { inbox } = service([card('o/r#4', { status: 'Todo' })], fakeActivity())
    const detail = await inbox.detail('o/r#4')
    expect(detail?.item).toMatchObject({ group: 'idle', kind: 'idle', actions: [] })
    expect(await inbox.detail('o/r#99')).toBeUndefined()
  })

  it('the doubt carries what the agent said', async () => {
    const closed: Row = {
      id: 'e2',
      key: 'k',
      task_ref: 'o/r#1',
      pipeline_id: 'refine',
      status: 'done',
      started_at: '2026-09-29T10:00:00Z',
      closed_at: '2026-09-29T10:10:00Z',
      failure: { by: 'agent', message: '¿Aplica a downgrades?' },
    }
    const { inbox } = service(
      [card('o/r#1', { status: 'Refine', labels: ['blocked'] })],
      fakeActivity([closed]),
    )
    const [item] = (await inbox.inbox()).items
    expect(item).toMatchObject({ kind: 'doubt', agent_said: '¿Aplica a downgrades?' })
  })

  it('explains with the last dispatched event, or a synthetic one of another type', async () => {
    const last: StoredEvent = {
      id: 'ev1',
      type: 'projects_v2_item.edited',
      payload: { fieldName: 'Working' },
    }
    const { inbox, explained } = service([card('o/r#1')], fakeActivity([], {}, last))

    const same = await inbox.explain('o/r#1')
    expect(same).toMatchObject({ source: 'last_event', event: { type: 'projects_v2_item.edited' } })
    const other = await inbox.explain('o/r#1', 'issue.unblocked')
    expect(other?.source).toBe('synthetic')
    expect(explained.at(-1)).toMatchObject({
      type: 'issue.unblocked',
      payload: { fieldName: 'Working' },
    })
  })
})
