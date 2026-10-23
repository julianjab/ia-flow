import { describe, expect, it } from 'bun:test'
import {
  type EventLogEntry,
  type ExecutionSummary,
  InboxSchema,
  RepoIssuesSchema,
  type RunnerCapacity,
  TasksSchema,
} from '@ia-flow/shared'
import type { ActivityPort, StoredEvent } from './ActivityPort.js'
import type { BoardMeta, BoardSpec } from './BoardReader.js'
import type { BoardCard } from './classify.js'
import { InboxSection } from './InboxSection.js'
import { InboxService } from './InboxService.js'
import type { RepoIssuesRead } from './RepoIssuesReader.js'

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
  when?: BoardSpec['when'],
  capacity?: () => RunnerCapacity,
) {
  const explained: StoredEvent[] = []
  const inbox = new InboxService({
    projects: [
      { projectId: 'p', board: { owner: 'la-haus', number: 1 }, ...(when ? { when } : {}) },
    ],
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
    ...(capacity ? { capacity } : {}),
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
    expect(result.items[0]).toMatchObject({
      unlocks: 1,
      priority: 1,
      reasons: ['a un merge de Done', 'destraba 1 tarea'],
    })
    expect(result.items.slice(1).map((item) => item.priority)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(result.items[1]?.execution?.id).toBe('e1')
    // Sin `meta`, el link del Project se arma solo y el del board cae a él.
    const url = 'https://github.com/orgs/la-haus/projects/1'
    expect(result.projects).toEqual([
      { id: 'p', board: { owner: 'la-haus', number: 1 }, url, board_url: url },
    ])
  })

  it('ranks the decisions by leverage: at the same case, what unblocks more goes first', async () => {
    const { inbox } = service(
      [
        card('o/r#1', { status: 'Refined', updatedAt: '2026-09-28T00:00:00Z' }),
        card('o/r#2', { status: 'Refined' }),
        card('o/r#3', { status: 'Todo', blockedBy: ['o/r#2'] }),
      ],
      fakeActivity(),
    )

    const { items } = await inbox.inbox()

    expect(items.map((item) => [item.ref, item.priority])).toEqual([
      ['o/r#2', 1],
      ['o/r#1', 2],
      ['o/r#3', undefined],
    ])
    expect(items[0]?.reasons).toContain('destraba 1 tarea')
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

  it('the project when decides which cards of the board are the project, in the inbox and the rest', async () => {
    const { inbox } = service(
      [
        card('o/r#1', { status: 'Refined' }),
        card('o/r#2', { status: 'Refined', labels: ['blocked'] }),
        card('o/r#3', { status: 'Todo', labels: ['blocked'] }),
      ],
      fakeActivity(),
      [],
      undefined,
      [{ field: 'item.labels', op: 'notContains', value: 'blocked' }],
    )
    expect((await inbox.inbox()).items.map((item) => item.ref)).toEqual(['o/r#1'])
    expect(await inbox.item('o/r#2')).toBeUndefined()
    expect((await inbox.rest()).columns.flatMap((c) => c.items.map((i) => i.ref))).toEqual([])
  })

  it('the rest of the board brings the closed cards only when asked, newest first', async () => {
    const closed = [
      {
        ref: 'o/r#8',
        projectId: 'p',
        title: 'Vieja',
        url: 'u8',
        status: 'Done',
        labels: [],
        closedAt: '2026-01-01T00:00:00Z',
      },
      {
        ref: 'o/r#9',
        projectId: 'p',
        title: 'Nueva',
        url: 'u9',
        status: 'Done',
        labels: [],
        closedAt: '2026-01-05T00:00:00Z',
      },
    ]
    const inbox = new InboxService({
      projects: [{ projectId: 'p', board: { owner: 'o', number: 1 } }],
      board: { cards: async () => [], closed: async () => closed },
      activity: fakeActivity(),
      waitingKeys: () => [],
      explain: async () => [],
      settings: InboxSection.parse({}),
    })
    expect((await inbox.rest()).closed).toBeUndefined()
    const rest = await inbox.rest(undefined, { closed: true })
    expect(rest.closed?.map((c) => [c.ref, c.closed_at])).toEqual([
      ['o/r#9', '2026-01-05T00:00:00Z'],
      ['o/r#8', '2026-01-01T00:00:00Z'],
    ])
  })

  it('a task outside the inbox still has a detail, as idle', async () => {
    const { inbox } = service([card('o/r#4', { status: 'Todo' })], fakeActivity())
    const detail = await inbox.detail('o/r#4')
    expect(detail?.item).toMatchObject({ group: 'idle', kind: 'idle', actions: ['comment'] })
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

  it('says how busy the runner is: running, queued and paused, with the global cap', async () => {
    const stats = { running: 2, waiting: 1, paused: 3, max_concurrent: 4, free: 2 }
    const { inbox } = service([], fakeActivity(), [], undefined, undefined, () => stats)

    const result = await inbox.inbox()

    expect(result.pipeline).toEqual({ running: 2, queued: 1, paused: 3, capacity: 4, free: 2 })
    expect(InboxSchema.parse(result).pipeline).toEqual(result.pipeline)
  })

  it('without a capacity port the inbox has no pipeline (and still parses)', async () => {
    const result = await service([], fakeActivity()).inbox.inbox()
    expect(result.pipeline).toBeUndefined()
    expect(() => InboxSchema.parse(result)).not.toThrow()
  })

  it('the feed: Todo cards ready to start and the ones waiting on another, minus what already started', async () => {
    const { inbox } = service(
      [
        card('o/r#1', { status: 'Todo' }),
        card('o/r#2', { status: 'Todo', blockedBy: ['o/r#5'] }),
        card('o/r#3', { status: 'Todo' }),
        card('o/r#5', { status: 'Build' }),
      ],
      fakeActivity(),
      ['[["issue","o/r#3"],["projectId","p"]]'],
    )

    const { feed } = await inbox.inbox()

    expect(feed?.ready.map((item) => item.ref)).toEqual(['o/r#1'])
    expect(feed?.waiting.map((item) => [item.ref, item.blocked_by])).toEqual([['o/r#2', ['o/r#5']]])
  })

  it('a sub-issue carries its epic and progress in the inbox and in the tasks; without a parent, none', async () => {
    const epic = { ref: 'o/r#9', title: 'Bandeja', done: 2, total: 5 }
    const { inbox } = service(
      [card('o/r#1', { status: 'Refined', epic }), card('o/r#2', { status: 'Refined' })],
      fakeActivity(),
    )

    const result = await inbox.inbox()
    const byRef = new Map(result.items.map((item) => [item.ref, item]))
    expect(byRef.get('o/r#1')?.epic).toEqual(epic)
    expect(byRef.get('o/r#2')).not.toHaveProperty('epic')
    expect(InboxSchema.parse(result).items.find((item) => item.ref === 'o/r#1')?.epic).toEqual(epic)
    expect((await inbox.item('o/r#1'))?.epic).toEqual(epic)

    const tasks = await inbox.tasks()
    const facts = new Map(tasks.tasks.map((task) => [task.ref, task]))
    expect(facts.get('o/r#1')?.epic).toEqual(epic)
    expect(facts.get('o/r#2')).not.toHaveProperty('epic')
    expect(TasksSchema.parse(tasks).tasks.find((task) => task.ref === 'o/r#1')?.epic).toEqual(epic)
  })
})

describe('InboxService — la bandeja ya armada', () => {
  function counting(cacheMs?: number) {
    let reads = 0
    const activity = fakeActivity()
    const inbox = new InboxService({
      projects: [{ projectId: 'p', board: { owner: 'la-haus', number: 1 } }],
      board: {
        cards: async () => {
          reads += 1
          return [card('o/r#1', { status: 'Refined' })]
        },
      },
      activity,
      waitingKeys: () => [],
      explain: async () => [],
      settings: InboxSection.parse({}),
      ...(cacheMs !== undefined ? { cacheMs } : {}),
      now: () => now,
    })
    return { inbox, reads: () => reads }
  }

  it('sin cacheMs se arma en cada pedido', async () => {
    const { inbox, reads } = counting()
    await inbox.inbox()
    await inbox.inbox()
    expect(reads()).toBe(2)
  })

  it('con cacheMs, los pedidos repetidos (y los simultáneos) comparten el armado hasta invalidate', async () => {
    const { inbox, reads } = counting(60_000)
    const [a, b] = await Promise.all([inbox.inbox(), inbox.inbox()])
    expect(a).toBe(b)
    await inbox.inbox()
    expect(reads()).toBe(1)
    await inbox.tasks()
    expect(reads()).toBe(2)
    inbox.invalidate()
    await inbox.inbox()
    expect(reads()).toBe(3)
  })

  it('un armado que falla no queda guardado', async () => {
    let fail = true
    const inbox = new InboxService({
      projects: [{ projectId: 'p', board: { owner: 'la-haus', number: 1 } }],
      board: {
        cards: async () => {
          if (fail) throw new Error('GitHub caído')
          return []
        },
      },
      activity: fakeActivity(),
      waitingKeys: () => [],
      explain: async () => [],
      settings: InboxSection.parse({}),
      cacheMs: 60_000,
      now: () => now,
    })
    await expect(inbox.inbox()).rejects.toThrow('GitHub caído')
    fail = false
    await expect(inbox.inbox()).resolves.toMatchObject({ items: [] })
  })
})

describe('InboxService — los agentes de una ejecución', () => {
  const review = (patch: Partial<Row>): Row => ({
    id: 'e',
    key: 'k',
    task_ref: 'o/r#1',
    pipeline_id: 'review',
    status: 'running',
    started_at: '2026-09-29T11:00:00Z',
    ...patch,
  })
  const lanes = [
    {
      agent_id: 'reviewer',
      state: 'done' as const,
      started_at: '2026-09-29T11:00:00Z',
      last_step_at: '2026-09-29T11:20:00Z',
    },
    {
      agent_id: 'e2e-visual-qa',
      state: 'running' as const,
      started_at: '2026-09-29T11:00:00Z',
      last_step_at: '2026-09-29T11:58:00Z',
    },
  ]
  /** Le pone los agentes a las vivas y a las que elige `withAgents`, como `withLiveness`. */
  function withLanes(rows: Row[]) {
    const seen: string[] = []
    const inbox = new InboxService({
      projects: [{ projectId: 'p', board: { owner: 'o', number: 1 } }],
      board: { cards: async () => [card('o/r#1', { status: 'Review' })] },
      activity: fakeActivity(rows),
      waitingKeys: () => [],
      explain: async () => [],
      settings: InboxSection.parse({}),
      now: () => now,
      liveness: (executions, withAgents) =>
        executions.map((execution, index) => {
          seen.push(execution.id)
          const live = execution.status === 'running' || execution.status === 'paused'
          return live || withAgents?.(execution, index)
            ? { ...execution, agents: lanes }
            : execution
        }),
    })
    return { inbox, seen }
  }

  it('lo que corre llega a la bandeja y a las tareas con cada uno de sus agentes', async () => {
    const { inbox } = withLanes([review({})])
    const item = (await inbox.inbox()).items.find((entry) => entry.ref === 'o/r#1')
    expect(item?.execution?.agents?.map((agent) => agent.state)).toEqual(['done', 'running'])
    const task = (await inbox.tasks()).tasks.find((entry) => entry.ref === 'o/r#1')
    expect(task?.live_run?.agents).toHaveLength(2)
    expect(InboxSchema.safeParse(await inbox.inbox()).success).toBe(true)
  })

  it('el detalle trae los agentes de la última ejecución aunque haya cerrado, no de las viejas', async () => {
    const { inbox } = withLanes([
      review({ id: 'new', status: 'done' }),
      review({ id: 'old', status: 'done', started_at: '2026-09-29T09:00:00Z' }),
    ])
    const detail = await inbox.detail('o/r#1')
    expect(detail?.executions.map((execution) => execution.agents?.length)).toEqual([2, undefined])
  })
})

describe('InboxService.repoIssues', () => {
  const row = (ref: string, updatedAt: string) => ({
    ref,
    title: ref,
    url: `https://github.com/${ref.replace('#', '/issues/')}`,
    labels: [],
    updatedAt,
  })

  function withRepos(reads: Record<string, RepoIssuesRead>) {
    const asked: string[] = []
    const boards: Record<string, BoardCard[]> = {
      p: [card('o/api#1')],
      // Una card de otro board (que no cumple el `when` de nadie) igual cuenta como card.
      q: [card('O/Web#7', { projectId: 'q' })],
    }
    const inbox = new InboxService({
      projects: [
        { projectId: 'p', board: { owner: 'o', number: 1 }, repos: ['o/api', 'o/web'] },
        {
          projectId: 'q',
          board: { owner: 'o', number: 2 },
          repos: ['o/web', 'o/gone'],
          when: [{ field: 'item.status', op: 'eq', value: 'Nunca' }],
        },
      ],
      board: { cards: async (spec) => boards[spec.projectId] ?? [] },
      repoIssues: {
        issues: async (repo) => {
          asked.push(repo)
          return reads[repo] ?? { issues: [], more: false }
        },
      },
      activity: fakeActivity(),
      waitingKeys: () => [],
      explain: async () => [],
      settings: InboxSection.parse({}),
    })
    return { inbox, asked }
  }

  it('lists, per catalog repo, the open issues without a card on any board of the runner', async () => {
    const { inbox, asked } = withRepos({
      'o/api': {
        issues: [row('o/api#1', '2026-10-03T00:00:00Z'), row('o/api#2', '2026-10-02T00:00:00Z')],
        more: false,
      },
      'o/web': {
        issues: [row('o/web#7', '2026-10-05T00:00:00Z'), row('o/web#8', '2026-10-01T00:00:00Z')],
        more: true,
      },
      'o/gone': { issues: [], more: false, error: 'El repo no existe o el runner no tiene acceso' },
    })
    const result = RepoIssuesSchema.parse(await inbox.repoIssues())
    // Un repo en el catálogo de dos proyectos se lee y se muestra una vez, con el primero.
    expect(asked).toEqual(['o/api', 'o/web', 'o/gone'])
    expect(result.repos).toEqual([
      {
        repo: 'o/api',
        project_id: 'p',
        items: [expect.objectContaining({ ref: 'o/api#2', project_id: 'p' })],
      },
      {
        repo: 'o/web',
        project_id: 'p',
        items: [expect.objectContaining({ ref: 'o/web#8' })],
        truncated: true,
      },
      {
        repo: 'o/gone',
        project_id: 'q',
        items: [],
        error: 'El repo no existe o el runner no tiene acceso',
      },
    ])
  })

  it('narrows to the repos of one project, still excluding the cards of every board', async () => {
    const { inbox, asked } = withRepos({
      'o/web': { issues: [row('o/web#7', '2026-10-05T00:00:00Z')], more: false },
    })
    const result = await inbox.repoIssues('q')
    expect(asked).toEqual(['o/web', 'o/gone'])
    expect(result?.repos.map((repo) => [repo.repo, repo.project_id, repo.items.length])).toEqual([
      ['o/web', 'q', 0],
      ['o/gone', 'q', 0],
    ])
  })

  it('without a repo reader there is nothing to answer', async () => {
    const { inbox } = service([], fakeActivity())
    expect(await inbox.repoIssues()).toBeUndefined()
  })
})
