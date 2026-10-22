import { describe, expect, it } from 'bun:test'
import {
  createEvent,
  type DomainEvent,
  EventBus,
  type PipelineExecutionContext,
} from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import type { GithubTaskReader } from '@ia-flow/github-tools'
import { IssuesBoard } from '../board/IssuesBoard.js'
import { ResolveTaskAction } from './ResolveTaskAction.js'

const project = {
  id: 'p',
  board: { owner: 'o', number: 1 },
  repos: ['o/r'],
  reposText: '- r (o/r)',
}

/** GitHub de mentira: el issue o/r#7, en Build en el board de `project`, con `labels`. `extra`
 *  pisa lo que haga falta (los comentarios del issue, cuándo se puso un label). */
function reader(
  labels: string[],
  calls: string[] = [],
  extra: Record<string, unknown> = {},
): GithubTaskReader {
  const fake = {
    withItemCache: () => fake,
    itemsOfIssue: async () => [
      {
        id: 'PVTI_1',
        project: { number: 1, owner: { login: 'o' } },
        fieldValues: { nodes: [{ name: 'Build', field: { name: 'Status' } }] },
      },
    ],
    linkedBranches: async () => {
      calls.push('linkedBranches')
      return []
    },
    context: async () => ({
      issue: { title: 't', body: '', html_url: 'https://github.com/o/r/issues/7', labels },
      blockers: [],
      issueComments: [],
    }),
    ...extra,
  }
  return fake as unknown as GithubTaskReader
}

/** Un comentario humano en o/r#7, como lo manda GitHub. */
const comment = createEvent('github.issue_comment', {
  action: 'created',
  issue: { number: 7, title: 't', labels: [] },
  repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } },
  sender: { login: 'julian' },
  comment: { id: 1, body: 'hola', user: { login: 'julian' } },
})

async function run(
  input: Record<string, unknown>,
  labels: string[],
  calls: string[] = [],
  event: DomainEvent<unknown> = comment,
  proyecto: typeof project = project,
) {
  const bus = new EventBus()
  const published: DomainEvent<unknown>[] = []
  bus.subscribe('*', (event) => {
    published.push(event)
  })
  const branchNamer: string[] = []
  const ctx = {
    event,
    bus,
    capabilities: {
      invoke: async () => {
        branchNamer.push('invoked')
        return { branch: 'feat/x' }
      },
    },
  } as unknown as PipelineExecutionContext
  const action = new ResolveTaskAction(() => [proyecto], reader(labels, calls))
  const result = await action.execute(action.input.parse(input), ctx)
  return { result, published, branchNamer }
}

describe('resolve_task when', () => {
  it('without when, every task of the board publishes its event', async () => {
    const { result, published } = await run({}, ['blocked'])
    expect(result).toEqual({ emitted: ['o/r#7'] })
    expect(published.map((event) => event.type)).toEqual(['issue_comment'])
  })

  it('a task that does not meet the when publishes nothing, and says which row failed', async () => {
    const when = [{ field: 'item.labels', op: 'notContains', value: 'blocked' }]
    const { result, published, branchNamer } = await run({ when }, ['blocked'])
    // Ningún evento de la task: sólo la constancia de que el comentario quedó retenido.
    expect(published.map((event) => event.type)).toEqual(['issue_comment.held'])
    expect('skipped' in result && result.skipped).toMatch(/o\/r#7 no cumple el when del intake/)
    expect('skipped' in result && result.skipped).toMatch(/item\.labels/)
    // Se descarta antes de proponer la rama: el branch-namer (un modelo) no corre.
    expect(branchNamer).toEqual([])
  })

  it('a task that meets the when publishes as usual', async () => {
    const when = [{ field: 'item.labels', op: 'contains', value: 'blocked' }]
    const { result, published } = await run({ when }, ['blocked'])
    expect(result).toEqual({ emitted: ['o/r#7'] })
    expect(published[0]?.payload).toMatchObject({ item: { labels: ['blocked'] } })
  })

  it('rows combine left to right, as in a pipeline when', async () => {
    const when = [
      { field: 'item.labels', op: 'contains', value: 'ia-flow' },
      { field: 'item.status', op: 'eq', value: 'Build', logic: 'or' },
    ]
    const { result } = await run({ when }, [])
    expect(result).toEqual({ emitted: ['o/r#7'] })
  })

  it('rejects a row that is not a condition', () => {
    const action = new ResolveTaskAction(() => [project], reader([]))
    expect(() => action.input.parse({ when: [{ field: 'x', op: 'isAwesome' }] })).toThrow()
  })
})

describe('resolve_task issues', () => {
  /** El label que alguien le puso a o/r#7: la señal de un board que no emite `projects_v2_item`. */
  const labeled = createEvent('github.issues', {
    action: 'labeled',
    label: { name: 'build' },
    issue: { number: 7, title: 't', labels: [{ name: 'build' }] },
    repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } },
    sender: { login: 'julian' },
  })

  it('a label on an issue of the board publishes issue.labeled with the label at the root', async () => {
    const { result, published } = await run({}, ['build'], [], labeled)
    expect(result).toEqual({ emitted: ['o/r#7'] })
    expect(published.map((event) => event.type)).toEqual(['issue.labeled'])
    expect(published[0]?.payload).toMatchObject({
      label: 'build',
      sender: 'julian',
      item: { status: 'Build', labels: ['build'] },
    })
  })

  it('an action no pipeline listens to publishes nothing', async () => {
    const closed = createEvent('github.issues', {
      ...(labeled.payload as object),
      action: 'closed',
    })
    const { result, published } = await run({}, ['build'], [], closed)
    expect(published).toEqual([])
    expect(result).toEqual({ skipped: 'p: issues.closed' })
  })
})

describe('resolve_task on a board of issues', () => {
  /** El board de issues de o/r: el estado de #7 está en sus labels, que GitHub devuelve por REST. */
  const issuesBoard = new IssuesBoard(
    'p',
    {
      requestJson: async () => ({ labels: [{ name: 'status:build' }] }),
    } as unknown as GithubClient,
    { repos: [{ owner: 'o', repo: 'r' }], statuses: ['Todo', 'Build', 'Review'] },
  )
  const proyecto = { ...project, intake: issuesBoard.intake, locate: issuesBoard.locate }

  /** El label de columna que alguien puso en o/r#7. */
  const moved = createEvent('github.issues', {
    action: 'labeled',
    label: { name: 'status:build' },
    issue: { number: 7, title: 't', labels: [{ name: 'status:build' }] },
    repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } },
    sender: { login: 'julian' },
  })

  it('publishes the same issue.status_changed a Project v2 would, with the column from the labels', async () => {
    const { result, published } = await run({}, ['status:build'], [], moved, proyecto)
    expect(result).toEqual({ emitted: ['o/r#7'] })
    expect(published.map((event) => event.type)).toEqual(['issue.status_changed'])
    expect(published[0]?.payload).toMatchObject({
      to: 'Build',
      sender: 'julian',
      item: { status: 'Build' },
    })
  })

  it('does not fall over for an issue that has no card on a Project: the issue itself is the card', async () => {
    const { reader: _ignored, ...sinProject } = proyecto as typeof proyecto & { reader?: unknown }
    const { result } = await run({}, ['status:build'], [], moved, sinProject)
    expect(result).toEqual({ emitted: ['o/r#7'] })
  })

  it('ignores an issue of a repo the board does not read', async () => {
    const ajeno = createEvent('github.issues', {
      ...(moved.payload as object),
      repository: { name: 'otro', full_name: 'o/otro', owner: { login: 'o' } },
    })
    const { result, published } = await run({}, [], [], ajeno, proyecto)
    expect(published).toEqual([])
    expect('skipped' in result && result.skipped).toMatch(/no es del catálogo de p/)
  })
})

describe('resolve_task on a pull request', () => {
  /** `e2e-test` puesto en el PR o/r#30 (rama `fix/x`), como lo manda GitHub. */
  const prLabeled = (label = 'e2e-test', state = 'open') =>
    createEvent('github.pull_request', {
      action: 'labeled',
      label: { name: label },
      pull_request: {
        number: 30,
        title: 'Arregla X',
        body: 'Lo que cambia',
        state,
        user: { login: 'julian' },
        head: { ref: 'fix/x', sha: 'abc' },
        base: { ref: 'main' },
        html_url: 'https://github.com/o/r/pull/30',
      },
      repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } },
      sender: { login: 'julian' },
    })

  /** GitHub de mentira para un PR: cierra `closing` (o ninguno), y su contexto. */
  function prReader(closing: number[], contexts: Array<Record<string, unknown>> = []) {
    const base = reader(['e2e-test']) as unknown as Record<string, unknown>
    const fake = {
      ...base,
      withItemCache: () => fake,
      closingIssues: async () => closing.map((number) => ({ owner: 'o', repo: 'r', number })),
      context: async (task: Record<string, unknown>) => {
        contexts.push(task)
        const pr = {
          number: 30,
          url: 'https://github.com/o/r/pull/30',
          headSha: 'abc',
          title: 'Arregla X',
          author: 'julian',
          headRef: 'fix/x',
          baseRef: 'main',
        }
        return task.pullRequestOnly
          ? {
              issue: {
                title: 'Arregla X',
                body: 'Lo que cambia',
                html_url: 'https://github.com/o/r/pull/30',
                labels: ['e2e-test'],
              },
              blockers: [],
              issueComments: [],
              openPr: pr,
            }
          : {
              issue: {
                title: 't',
                body: 'El PRD',
                html_url: 'https://github.com/o/r/issues/7',
                labels: [],
              },
              blockers: [],
              issueComments: [],
              openPr: pr,
            }
      },
    }
    return fake as unknown as GithubTaskReader
  }

  async function runPr(
    input: Record<string, unknown>,
    event: DomainEvent<unknown>,
    github: GithubTaskReader,
  ) {
    const bus = new EventBus()
    const published: DomainEvent<unknown>[] = []
    bus.subscribe('*', (e) => {
      published.push(e)
    })
    const ctx = {
      event,
      bus,
      capabilities: { invoke: async () => ({ branch: 'feat/x' }) },
    } as unknown as PipelineExecutionContext
    const action = new ResolveTaskAction(() => [project], github)
    const result = await action.execute(action.input.parse(input), ctx)
    return { result, published }
  }

  const E2E_ROWS = [
    { field: 'eventType', op: 'eq', value: 'pull_request' },
    { field: 'action', op: 'eq', value: 'labeled' },
    { field: 'label', op: 'eq', value: 'e2e-test' },
  ]

  it('a label on a PR that closes an issue is the event of that issue, with its PRD', async () => {
    const { result, published } = await runPr({}, prLabeled(), prReader([7]))
    expect(result).toEqual({ emitted: ['o/r#7'] })
    expect(published[0]?.payload).toMatchObject({
      number: 7,
      label: 'e2e-test',
      item: { status: 'Build', kind: 'issue' },
      task: { description: 'El PRD', pr: { number: 30 } },
    })
    expect(published[0]?.scope).not.toHaveProperty('kind')
  })

  it('a PR without an issue is skipped unless the project asks for it', async () => {
    const { result, published } = await runPr({}, prLabeled(), prReader([]))
    expect(published).toEqual([])
    expect(result).toEqual({ skipped: 'p: PR #30 no cierra ningún issue' })
  })

  it('with pullRequestsWithoutIssue, the PR itself is the task: its body, its branch, no card', async () => {
    const contexts: Array<Record<string, unknown>> = []
    const { result, published } = await runPr(
      { pullRequestsWithoutIssue: E2E_ROWS },
      prLabeled(),
      prReader([], contexts),
    )
    expect(result).toEqual({ emitted: ['o/r#30'] })
    expect(contexts[0]).toMatchObject({ number: 30, pr: 30, pullRequestOnly: true })
    const payload = published[0]?.payload as Record<string, Record<string, unknown>>
    expect(published[0]?.type).toBe('pull_request')
    expect(payload).toMatchObject({
      number: 30,
      label: 'e2e-test',
      item: { kind: 'pr', labels: ['e2e-test'], blocked: false },
      task: {
        id: 'o/r#30',
        description: 'Lo que cambia',
        issueUrl: 'https://github.com/o/r/pull/30',
        branch: 'fix/x',
        pr: { number: 30 },
      },
    })
    expect(payload.item?.status).toBeUndefined()
    expect(published[0]?.scope).toMatchObject({ issue: 'o/r#30', kind: 'pr' })
  })

  it('any other event of a PR without an issue is still skipped', async () => {
    const { result, published } = await runPr(
      { pullRequestsWithoutIssue: E2E_ROWS },
      prLabeled('bug'),
      prReader([]),
    )
    expect(published).toEqual([])
    expect('skipped' in result && result.skipped).toMatch(/un PR sin issue\) no cumple el when/)
  })

  it('the when of the intake also applies to a PR without an issue', async () => {
    const { result, published } = await runPr(
      {
        when: [{ field: 'item.labels', op: 'notContains', value: 'e2e-test' }],
        pullRequestsWithoutIssue: E2E_ROWS,
      },
      prLabeled(),
      prReader([]),
    )
    expect(published).toEqual([])
    expect('skipped' in result && result.skipped).toMatch(/item\.labels/)
  })

  it('an empty pullRequestsWithoutIssue opens nothing', async () => {
    const { result } = await runPr({ pullRequestsWithoutIssue: [] }, prLabeled(), prReader([]))
    expect(result).toEqual({ skipped: 'p: PR #30 no cierra ningún issue' })
  })
})

describe('resolve_task notifyParent', () => {
  /** o/r#12 cerrado (por el merge de su PR o a mano), como lo manda GitHub. */
  const closed = (action = 'closed', stateReason?: string) =>
    createEvent('github.issues', {
      action,
      issue: {
        number: 12,
        title: 'Un hijo',
        labels: [],
        ...(stateReason ? { state_reason: stateReason } : {}),
      },
      repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } },
      sender: { login: 'julian' },
    })

  /** GitHub de mentira: la épica es o/r#7 (en el board), o `parent` si se dice otro. */
  async function notify(
    event: DomainEvent<unknown>,
    options: {
      parent?: { owner: string; repo: string; number: number } | null
      labels?: string[]
    } = {},
    input: Record<string, unknown> = {},
  ) {
    const base = reader(options.labels ?? []) as unknown as Record<string, unknown>
    const asked: string[] = []
    const fake = {
      ...base,
      withItemCache: () => fake,
      parentOf: async (owner: string, repo: string, number: number) => {
        asked.push(`${owner}/${repo}#${number}`)
        if (options.parent === null) return undefined
        return options.parent ?? { owner: 'o', repo: 'r', number: 7 }
      },
    }
    const bus = new EventBus()
    const published: DomainEvent<unknown>[] = []
    bus.subscribe('*', (e) => {
      published.push(e)
    })
    const ctx = {
      event,
      bus,
      capabilities: { invoke: async () => ({ branch: 'feat/x' }) },
    } as unknown as PipelineExecutionContext
    const action = new ResolveTaskAction(() => [project], fake as unknown as GithubTaskReader)
    const result = await action.execute(action.input.parse({ notifyParent: true, ...input }), ctx)
    return { result, published, asked }
  }

  it('a closed sub-issue is issue.child_closed on its epic, with the child and why it closed', async () => {
    const { result, published, asked } = await notify(closed('closed', 'completed'))
    expect(asked).toEqual(['o/r#12'])
    expect(result).toEqual({ emitted: ['o/r#7'] })
    expect(published.map((event) => event.type)).toEqual(['issue.child_closed'])
    expect(published[0]?.payload).toMatchObject({
      child: 'o/r#12',
      childUrl: 'https://github.com/o/r/issues/12',
      stateReason: 'completed',
      message: 'Se cerró el sub-issue o/r#12 (completed).',
    })
    expect(published[0]?.scope).toMatchObject({ projectId: 'p', issue: 'o/r#7' })
  })

  it('a sub-issue closed as not planned also reaches the epic: deciding what follows is its job', async () => {
    const { published } = await notify(closed('closed', 'not_planned'))
    expect(published[0]?.payload).toMatchObject({ stateReason: 'not_planned' })
  })

  it('an issue without a parent publishes nothing', async () => {
    const { result, published } = await notify(closed(), { parent: null })
    expect(published).toEqual([])
    expect(result).toEqual({ skipped: 'p: o/r#12 no es sub-issue de nada' })
  })

  it('an epic outside the catalog is not of this project', async () => {
    const { result, published } = await notify(closed(), {
      parent: { owner: 'otra', repo: 'cosa', number: 1 },
    })
    expect(published).toEqual([])
    expect(result).toEqual({ skipped: 'p: el padre de o/r#12 no es del catálogo de p' })
  })

  it('anything but a close is skipped before reading GitHub', async () => {
    const { result, asked } = await notify(closed('reopened'))
    expect(asked).toEqual([])
    expect(result).toEqual({ skipped: 'p: issues.reopened' })
  })

  it('the when of the intake applies to the epic', async () => {
    const when = [{ field: 'item.labels', op: 'notContains', value: 'blocked' }]
    const { result, published } = await notify(closed(), { labels: ['blocked'] }, { when })
    expect(published).toEqual([])
    expect('skipped' in result && result.skipped).toMatch(/o\/r#7 no cumple el when del intake/)
  })
})

describe('resolve_task notifyParentOfStatus', () => {
  /** La card de o/r#12 movida en el board, como lo manda GitHub. */
  const moved = (fieldValue: Record<string, unknown>) =>
    createEvent('github.projects_v2_item', {
      action: 'edited',
      projects_v2_item: {
        node_id: 'PVTI_12',
        project_node_id: 'PVT_1',
        content_node_id: 'I_12',
        content_type: 'Issue',
      },
      changes: { field_value: fieldValue },
      sender: { login: 'ia-flow[bot]' },
    })
  const toRefined = moved({
    field_name: 'Status',
    field_type: 'single_select',
    from: { name: 'Refine' },
    to: { name: 'Refined' },
  })

  /** GitHub de mentira: el item PVTI_12 es o/r#12, sub-issue de la épica o/r#7 (o de `parent`). */
  async function notify(
    event: DomainEvent<unknown>,
    parent: { owner: string; repo: string; number: number } | null = {
      owner: 'o',
      repo: 'r',
      number: 7,
    },
  ) {
    const base = reader([]) as unknown as Record<string, unknown>
    const asked: string[] = []
    const fake = {
      ...base,
      withItemCache: () => fake,
      issueOfItem: async () => ({
        board: { owner: 'o', number: 1 },
        owner: 'o',
        repo: 'r',
        number: 12,
      }),
      parentOf: async (owner: string, repo: string, number: number) => {
        asked.push(`${owner}/${repo}#${number}`)
        return parent ?? undefined
      },
    }
    const bus = new EventBus()
    const published: DomainEvent<unknown>[] = []
    bus.subscribe('*', (e) => {
      published.push(e)
    })
    const ctx = {
      event,
      bus,
      capabilities: { invoke: async () => ({ branch: 'feat/x' }) },
    } as unknown as PipelineExecutionContext
    const action = new ResolveTaskAction(() => [project], fake as unknown as GithubTaskReader)
    const result = await action.execute(action.input.parse({ notifyParentOfStatus: true }), ctx)
    return { result, published, asked }
  }

  it('a sub-issue that changes column is issue.child_status_changed on its epic, with from/to', async () => {
    const { result, published, asked } = await notify(toRefined)
    expect(asked).toEqual(['o/r#12'])
    expect(result).toEqual({ emitted: ['o/r#7'] })
    expect(published.map((event) => event.type)).toEqual(['issue.child_status_changed'])
    expect(published[0]?.payload).toMatchObject({
      child: 'o/r#12',
      childUrl: 'https://github.com/o/r/issues/12',
      from: 'Refine',
      to: 'Refined',
      message: 'El sub-issue o/r#12 pasó a Refined.',
    })
    expect(published[0]?.scope).toMatchObject({ projectId: 'p', issue: 'o/r#7' })
  })

  it('an edit that is not the column does not reach the epic', async () => {
    const { result, published, asked } = await notify(
      moved({ field_name: 'Task Type', field_type: 'single_select', to: { name: 'Technical' } }),
    )
    expect(published).toEqual([])
    expect(asked).toEqual([])
    expect('skipped' in result && result.skipped).toMatch(/no es un cambio de columna/)
  })

  it('an issue without a parent publishes nothing', async () => {
    const { result, published } = await notify(toRefined, null)
    expect(published).toEqual([])
    expect(result).toEqual({ skipped: 'p: o/r#12 no es sub-issue de nada' })
  })
})

describe('resolve_task held comments (ia-flow#331)', () => {
  const when = [{ field: 'item.labels', op: 'notContains', value: 'blocked' }]
  const BLOCKED_AT = '2026-10-20T20:43:47Z'
  /** `blocked` se le saca a o/r#7: la card vuelve a ser del runner. */
  const unblocked = createEvent('github.issues', {
    action: 'unlabeled',
    label: { name: 'blocked' },
    issue: { number: 7, title: 't', labels: [] },
    repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } },
    sender: { login: 'julian' },
  })
  const human = (id: number, at: string, body = `pedido ${id}`, login = 'julian') => ({
    id,
    body,
    created_at: at,
    user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
  })

  async function resolve(
    event: DomainEvent<unknown>,
    labels: string[],
    comments: ReturnType<typeof human>[],
    ledger: number[] = [],
  ) {
    const bus = new EventBus()
    const published: DomainEvent<unknown>[] = []
    bus.subscribe('*', (event) => {
      published.push(event)
    })
    const ctx = {
      event,
      bus,
      capabilities: { invoke: async () => ({ branch: 'feat/x' }) },
    } as unknown as PipelineExecutionContext
    const fake = reader(labels, [], {
      labeledAt: async (_o: string, _r: string, _n: number, label: string) =>
        label === 'blocked' ? BLOCKED_AT : undefined,
      context: async () => ({
        issue: { title: 't', body: '', html_url: 'https://github.com/o/r/issues/7', labels },
        blockers: [],
        issueComments: comments,
      }),
    })
    const action = new ResolveTaskAction(() => [project], fake, undefined, {
      has: (id) => ledger.includes(id),
    })
    const result = await action.execute(action.input.parse({ when }), ctx)
    return { result, published }
  }

  it('a human comment on a blocked task is held: on record with the reason, not lost in silence', async () => {
    const { result, published } = await resolve(comment, ['blocked'], [])
    expect('skipped' in result && result.skipped).toMatch(/no cumple el when del intake/)
    expect(published).toHaveLength(1)
    expect(published[0]?.type).toBe('issue_comment.held')
    expect(published[0]?.payload).toMatchObject({
      author: 'julian',
      commentId: 1,
      body: 'hola',
      reason: expect.stringMatching(/item\.labels notContains "blocked"/),
    })
    expect(published[0]?.scope).toMatchObject({ projectId: 'p', issue: 'o/r#7' })
  })

  it('a bot comment on a blocked task is not held: nobody asked for anything', async () => {
    const bot = createEvent('github.issue_comment', {
      ...(comment.payload as Record<string, unknown>),
      sender: { login: 'sonarqubecloud[bot]' },
    })
    const { published } = await resolve(bot, ['blocked'], [])
    expect(published).toEqual([])
  })

  it('unblocking replays, in order, the human comments written while blocked', async () => {
    const { published } = await resolve(
      unblocked,
      [],
      [
        human(10, '2026-10-20T20:30:00Z', 'antes de trabarse'),
        human(12, '2026-10-20T21:10:00Z', 'el segundo'),
        human(11, '2026-10-20T20:52:06Z', 'Ajusta el texto'),
        human(
          13,
          '2026-10-20T21:00:00Z',
          'reporte <!-- ia-flow:report -->',
          'ai-lh-developer[bot]',
        ),
        human(14, '2026-10-20T21:05:00Z', 'Quality Gate passed', 'sonarqubecloud[bot]'),
      ],
    )
    expect(published.map((event) => event.type)).toEqual([
      'issue.unlabeled',
      'issue_comment',
      'issue_comment',
    ])
    expect(published.slice(1).map((event) => event.payload)).toMatchObject([
      { body: 'Ajusta el texto', author: 'julian', commentId: 11, replayed: true },
      { body: 'el segundo', author: 'julian', commentId: 12, replayed: true },
    ])
  })

  it('a comment the runner posted for someone (answer and unblock) is not replayed', async () => {
    const { published } = await resolve(
      unblocked,
      [],
      [human(11, '2026-10-20T20:52:06Z', 'la respuesta')],
      [11],
    )
    expect(published.map((event) => event.type)).toEqual(['issue.unlabeled'])
  })

  it('removing a label that never kept the task out replays nothing', async () => {
    const reviewedOff = createEvent('github.issues', {
      ...(unblocked.payload as Record<string, unknown>),
      label: { name: 'reviewed' },
    })
    const { published } = await resolve(reviewedOff, [], [human(11, '2026-10-20T20:52:06Z')])
    expect(published.map((event) => event.type)).toEqual(['issue.unlabeled'])
  })
})

describe('resolve_task notifySiblingConflicts', () => {
  /** El merge del PR #20 de o/r, que cierra o/r#12: hijo de la épica o/r#5, hermano de o/r#7 (en
   *  el board, con el PR #21 abierto). */
  const merge = createEvent('github.pull_request', {
    action: 'closed',
    number: 20,
    pull_request: { number: 20, merged: true, head: { ref: 'feat/12' }, base: { ref: 'main' } },
    repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } },
    sender: { login: 'julian' },
  })

  async function resolve(mergeable: boolean | null) {
    const base = reader([]) as unknown as Record<string, unknown>
    const fake = {
      ...base,
      withItemCache: () => fake,
      closingIssues: async () => [{ owner: 'o', repo: 'r', number: 12 }],
      parentOf: async () => ({ owner: 'o', repo: 'r', number: 5 }),
      subIssues: async () => [
        { number: 12, state: 'open', repository_url: 'https://api.github.com/repos/o/r' },
        { number: 7, state: 'open', repository_url: 'https://api.github.com/repos/o/r' },
      ],
      openPullOf: async (_o: string, _r: string, number: number) => (number === 7 ? 21 : undefined),
      mergeable: async () => mergeable,
    }
    const bus = new EventBus()
    const published: DomainEvent<unknown>[] = []
    bus.subscribe('*', (e) => {
      published.push(e)
    })
    const ctx = {
      event: merge,
      bus,
      capabilities: { invoke: async () => ({ branch: 'feat/x' }) },
    } as unknown as PipelineExecutionContext
    const action = new ResolveTaskAction(() => [project], fake as unknown as GithubTaskReader)
    const result = await action.execute(action.input.parse({ notifySiblingConflicts: true }), ctx)
    return { result, published }
  }

  it('a sibling whose PR the merge left in conflict gets issue.pr_conflict, with what to do', async () => {
    const { result, published } = await resolve(false)
    expect(result).toEqual({ emitted: ['o/r#7'] })
    expect(published.map((event) => event.type)).toEqual(['issue.pr_conflict'])
    expect(published[0]?.payload).toMatchObject({
      mergedPr: 'o/r#20',
      mergedChild: 'o/r#12',
      epic: 'o/r#5',
      message: expect.stringContaining('quedó en conflicto con la rama base: se mergeó o/r#20'),
    })
    expect(published[0]?.scope).toMatchObject({ projectId: 'p', issue: 'o/r#7' })
  })

  it('a sibling still mergeable gets nothing', async () => {
    const { result, published } = await resolve(true)
    expect(published).toEqual([])
    expect(result).toEqual({ skipped: 'p: el PR #21 de o/r#7 sigue sin conflictos' })
  })
})
