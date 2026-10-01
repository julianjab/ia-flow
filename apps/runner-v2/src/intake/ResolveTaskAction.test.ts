import { describe, expect, it } from 'bun:test'
import {
  createEvent,
  type DomainEvent,
  EventBus,
  type PipelineExecutionContext,
} from '@ia-flow/agent-engine'
import type { GithubTaskReader } from '@ia-flow/github-tools'
import { ResolveTaskAction } from './ResolveTaskAction.js'

const project = {
  id: 'p',
  board: { owner: 'o', number: 1 },
  repos: ['o/r'],
  reposText: '- r (o/r)',
}

/** GitHub de mentira: el issue o/r#7, en Build en el board de `project`, con `labels`. */
function reader(labels: string[], calls: string[] = []): GithubTaskReader {
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
  const action = new ResolveTaskAction(() => [project], reader(labels, calls))
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
    expect(published).toEqual([])
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
