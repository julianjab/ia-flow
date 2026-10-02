import { describe, expect, it } from 'bun:test'
import type { Action } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { PostUserCommentAction, UpdateIssueAction } from '@ia-flow/github-tools'
import type { InboxItem } from '@ia-flow/shared'
import type { ActivityPort } from './ActivityPort.js'
import type { BoardCard } from './classify.js'
import { InboxSection } from './InboxSection.js'
import { InboxService } from './InboxService.js'
import { type TaskActionDefs, TaskActionsSchema } from './TaskActionDef.js'
import { TaskActions } from './TaskActions.js'

const defs: TaskActionDefs = TaskActionsSchema.parse({
  answer_and_unblock: {
    label: 'Responder y destrabar',
    available: [{ field: 'item.labels', op: 'contains', value: 'blocked' }],
    input: { comment: 'required' },
    confirm: '¿Publicar tu respuesta y devolverla a su etapa?',
    steps: [
      { action: 'post_user_comment', with: { body: '{{input.comment}}' } },
      { action: 'update_issue', with: { removeLabels: ['blocked'] } },
      { action: 'update_issue', with: { status: '{{task.resume_stage}}' } },
    ],
  },
})

const blocked: BoardCard = {
  ref: 'o/r#1',
  projectId: 'p',
  title: 't',
  url: 'u',
  status: 'Blocked',
  labels: ['blocked'],
  updatedAt: '2026-09-29T11:00:00Z',
  blockedBy: [],
}

const activity = (exit: string): ActivityPort => ({
  executions: ({ statuses }) =>
    !statuses || statuses.includes('done')
      ? [
          {
            id: 'e1',
            key: 'k',
            task_ref: 'o/r#1',
            pipeline_id: 'refine',
            status: 'done',
            started_at: '2026-09-29T10:00:00Z',
            closed_at: '2026-09-29T11:00:00Z',
            agent_id: 'refiner',
            exit,
            summary: 'falta #1578',
          },
        ]
      : [],
  lastEventAt: () => undefined,
  eventsForTask: () => [],
  recentEvents: () => [],
  trace: () => [],
  lastDispatchedEvent: () => undefined,
})

function inbox(taskActions: TaskActionDefs, exit = 'prerequisite') {
  return new InboxService({
    projects: [{ projectId: 'p', board: { owner: 'o', number: 1 } }],
    board: { cards: async () => [blocked] },
    activity: activity(exit),
    waitingKeys: () => [],
    explain: async () => [],
    settings: InboxSection.parse({}),
    taskActions: () => taskActions,
    now: () => new Date('2026-09-29T12:00:00Z'),
  })
}

describe('what the inbox offers', () => {
  it('a declared action replaces the built-in one and brings its label and input', async () => {
    const item = (await inbox(defs).item('o/r#1')) as InboxItem
    expect(item.kind).toBe('prerequisite')
    expect(item.actions).toEqual(['answer_and_unblock'])
    expect(item.action_defs).toEqual([
      {
        id: 'answer_and_unblock',
        label: 'Responder y destrabar',
        comment: 'required',
        confirm: '¿Publicar tu respuesta y devolverla a su etapa?',
      },
    ])
  })

  it('its guard decides: when it does not hold the built-in one is not offered either', async () => {
    const strict = TaskActionsSchema.parse({
      answer_and_unblock: {
        ...defs.answer_and_unblock,
        available: [{ field: 'run.exit', op: 'eq', value: 'doubt' }],
      },
    })
    const item = (await inbox(strict, 'prerequisite').item('o/r#1')) as InboxItem
    expect(item.actions).toEqual([])
    expect(item.action_defs).toBeUndefined()
  })

  it('offers nothing declared while an agent is running on the task', async () => {
    const running = activity('prerequisite')
    const live: ActivityPort = {
      ...running,
      executions: (query) =>
        query.statuses?.includes('running')
          ? [
              {
                id: 'e2',
                key: 'k',
                task_ref: 'o/r#1',
                pipeline_id: 'refine',
                status: 'running',
                started_at: '2026-09-29T11:30:00Z',
                agent_id: 'refiner',
              },
            ]
          : running.executions(query),
    }
    const service = new InboxService({
      projects: [{ projectId: 'p', board: { owner: 'o', number: 1 } }],
      board: { cards: async () => [blocked] },
      activity: live,
      waitingKeys: () => [],
      explain: async () => [],
      settings: InboxSection.parse({}),
      taskActions: () => defs,
      now: () => new Date('2026-09-29T12:00:00Z'),
    })
    const item = (await service.item('o/r#1')) as InboxItem
    expect(item.group).toBe('run')
    expect(item.actions).toEqual(['stop'])
    expect(item.action_defs).toBeUndefined()
  })

  it('without declarations the built-in actions stay as they were', async () => {
    const item = (await inbox({}).item('o/r#1')) as InboxItem
    expect(item.actions).toEqual(['answer_and_unblock'])
    expect(item.action_defs).toBeUndefined()
  })
})

describe('running a declared action as the person', () => {
  function setup() {
    const calls: string[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)} ${init?.body ?? ''}`.trim())
      return Response.json(
        String(input).endsWith('/repos/o/r')
          ? { permissions: { push: true } }
          : { html_url: 'https://github.com/o/r/issues/1#c' },
      )
    }) as typeof fetch
    const service = inbox(defs)
    const actions = new TaskActions({
      inbox: service,
      boards: { writerFor: () => undefined },
      settings: InboxSection.parse({}),
      taskActions: () => defs,
      instantiate: (_projectId, name, client: GithubClient): Action =>
        name === 'post_user_comment'
          ? new PostUserCommentAction({ client })
          : new UpdateIssueAction({
              client,
              board: {
                setFields: async (_issue, set) => {
                  calls.push(`BOARD ${JSON.stringify(set)}`)
                },
              },
            }),
      redispatch: async () => 'ok',
      rerunReview: async () => 'ok',
      stop: () => 'ok',
      resumeStage: () => 'Refine',
      changed: () => {},
      fetchImpl,
    })
    return { actions, calls }
  }

  it('comments as a person, takes blocked off, and only then moves the card back', async () => {
    const { actions, calls } = setup()
    const result = await actions.run(
      'o/r#1',
      { action: 'answer_and_unblock', comment: 'Sólo upgrades.' },
      { token: 't', login: 'julian' },
    )
    expect(result).toMatchObject({ ok: true, github_login: 'julian' })
    expect(calls).toEqual([
      'GET https://api.github.com/repos/o/r',
      'POST https://api.github.com/repos/o/r/issues/1/comments {"body":"Sólo upgrades."}',
      'DELETE https://api.github.com/repos/o/r/issues/1/labels/blocked',
      'BOARD {"Status":"Refine"}',
    ])
  })

  it('rejects a missing required comment before asking GitHub anything', async () => {
    const { actions, calls } = setup()
    await expect(
      actions.run('o/r#1', { action: 'answer_and_unblock' }, { token: 't', login: 'julian' }),
    ).rejects.toMatchObject({ status: 400 })
    expect(calls).toEqual([])
  })
})

describe('GET /api/tasks: the facts, unclassified', () => {
  const stopWhenRunning = TaskActionsSchema.parse({
    ...defs,
    stop: {
      label: 'Detener',
      available: [{ field: 'live.status', op: 'eq', value: 'running' }],
      steps: [{ action: 'stop_agent' }],
    },
  })
  const todo: BoardCard = { ...blocked, ref: 'o/r#2', status: 'Todo', labels: [], title: 'otra' }

  function tasksService(cards: BoardCard[], taskActions: TaskActionDefs, exit = 'prerequisite') {
    return new InboxService({
      projects: [{ projectId: 'p', board: { owner: 'o', number: 1 } }],
      board: { cards: async () => cards },
      activity: activity(exit),
      waitingKeys: () => [],
      explain: async () => [],
      settings: InboxSection.parse({}),
      taskActions: () => taskActions,
      capacity: () => ({ running: 1, waiting: 0, paused: 0, max_concurrent: 2, free: 1 }),
      now: () => new Date('2026-09-29T12:00:00Z'),
    })
  }

  it('lists every open card, with the facts a when can read and what the runner offers', async () => {
    const { tasks, capacity } = await tasksService([blocked, todo], stopWhenRunning).tasks()
    expect(tasks.map((task) => task.ref)).toEqual(['o/r#1', 'o/r#2'])
    expect(tasks[0]).toMatchObject({
      project_id: 'p',
      item: { status: 'Blocked', labels: ['blocked'] },
      run: { exit: 'prerequisite', agent: 'refiner', summary: 'falta #1578' },
      live: {},
      queue: { waiting: false },
      task: { idle_hours: 1, waiting_hours: 1, unlocks: 0, blocked_by: 0 },
      actions: ['answer_and_unblock'],
      action_defs: [{ id: 'answer_and_unblock', comment: 'required' }],
    })
    expect(tasks[0]?.last_run?.exit).toBe('prerequisite')
    // A card nobody has touched is still there — whether it is a decision is the dashboard's call.
    expect(tasks[1]).toMatchObject({ item: { status: 'Todo' }, run: {}, actions: [] })
    expect(capacity).toEqual({ running: 1, waiting: 0, paused: 0, max_concurrent: 2, free: 1 })
  })

  it('counts what each issue unlocks', async () => {
    const waiting: BoardCard = { ...todo, blockedBy: ['o/r#1'] }
    const { tasks } = await tasksService([blocked, waiting], {}).tasks()
    expect(tasks[0]?.task.unlocks).toBe(1)
    expect(tasks[1]?.task.blocked_by).toBe(1)
    expect(tasks[1]?.blocked_by_refs).toEqual(['o/r#1'])
  })

  it('without capacity or declarations it still answers', async () => {
    const service = new InboxService({
      projects: [{ projectId: 'p', board: { owner: 'o', number: 1 } }],
      board: { cards: async () => [blocked] },
      activity: activity('doubt'),
      waitingKeys: () => [],
      explain: async () => [],
      settings: InboxSection.parse({}),
    })
    const result = await service.tasks()
    expect(result.capacity).toEqual({ running: 0, waiting: 0, paused: 0 })
    expect(result.tasks[0]?.actions).toEqual([])
  })
})
