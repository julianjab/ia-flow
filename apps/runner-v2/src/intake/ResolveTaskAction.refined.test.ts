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
const REFINED = ['Refined', 'Build', 'Review', 'Done']

const item = (status: string) => [
  {
    id: `PVTI_${status}`,
    project: { number: 1, owner: { login: 'o' } },
    fieldValues: { nodes: [{ name: status, field: { name: 'Status' } }] },
  },
]

const issueUrl = (n: number) => `https://github.com/o/r/issues/${n}`

/**
 * GitHub de mentira: o/r#7 en Refine, bloqueado por o/r#1; o/r#1 en `blockerStatus`. `blocking` es
 * lo que bloquea cada issue (por número).
 */
function reader(blockerStatus: string, blocking: Record<number, number[]> = {}): GithubTaskReader {
  const fake = {
    withItemCache: () => fake,
    withStacking: () => fake,
    itemsOfIssue: async (_o: string, _r: string, number: number) =>
      item(number === 1 ? blockerStatus : 'Refine'),
    linkedBranches: async () => [],
    dependents: async (_o: string, _r: string, number: number) =>
      (blocking[number] ?? []).map((n) => ({
        number: n,
        state: 'open',
        repository_url: 'https://api.github.com/repos/o/r',
      })),
    context: async (task: { number: number }) => ({
      issue: { title: 't', body: '', html_url: issueUrl(task.number), labels: ['epic-hold'] },
      blockers:
        task.number === 7 ? [{ number: 1, title: 'a', state: 'open', html_url: issueUrl(1) }] : [],
      issueComments: [],
    }),
  }
  return fake as unknown as GithubTaskReader
}

/** Un comentario humano en o/r#7. */
const comment = createEvent('github.issue_comment', {
  action: 'created',
  issue: { number: 7, title: 't', labels: [] },
  repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } },
  sender: { login: 'julian' },
  comment: { id: 1, body: 'hola', user: { login: 'julian' } },
})

/** o/r#1 pasa de Refine a `to` en el board. */
const moved = (to: string) =>
  createEvent('github.projects_v2_item', {
    action: 'edited',
    projects_v2_item: { node_id: 'PVTI_x', content_type: 'Issue', content_node_id: 'I_1' },
    changes: {
      field_value: {
        field_name: 'Status',
        field_type: 'single_select',
        from: { name: 'Refine' },
        to: { name: to },
      },
    },
    repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } },
    sender: { login: 'julian' },
  })

async function run(
  input: Record<string, unknown>,
  fake: GithubTaskReader,
  event: DomainEvent<unknown> = comment,
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
  const action = new ResolveTaskAction(() => [project], fake)
  const result = await action.execute(action.input.parse(input), ctx)
  return { result, published }
}

const blockersRefinedOf = (event: DomainEvent<unknown> | undefined) =>
  (event?.payload as { item?: { blockersRefined?: boolean } } | undefined)?.item?.blockersRefined

describe('resolve_task refinedStatuses', () => {
  it('sin refinedStatuses, el evento no trae item.blockersRefined', async () => {
    const { published } = await run({}, reader('Refine'))
    expect(blockersRefinedOf(published[0])).toBeUndefined()
  })

  it('con el prerrequisito en Refine, item.blockersRefined es false', async () => {
    const { published } = await run({ refinedStatuses: REFINED }, reader('Refine'))
    expect(blockersRefinedOf(published[0])).toBe(false)
  })

  it('con el prerrequisito en Refined, item.blockersRefined es true aunque siga abierto', async () => {
    const { published } = await run({ refinedStatuses: REFINED }, reader('Refined'))
    expect(blockersRefinedOf(published[0])).toBe(true)
    expect(published[0]?.payload).toMatchObject({ item: { blocked: true } })
  })

  it('notifyBlockersRefined sin refinedStatuses no valida', () => {
    const action = new ResolveTaskAction(() => [project], reader('Refine'))
    expect(() => action.input.parse({ notifyBlockersRefined: true })).toThrow()
  })
})

describe('resolve_task notifyBlockersRefined', () => {
  const input = { refinedStatuses: REFINED, notifyBlockersRefined: true }
  /** El item del webhook es o/r#1. */
  const withItem = (fake: GithubTaskReader) =>
    Object.assign(fake, {
      issueOfItem: async () => ({
        owner: 'o',
        repo: 'r',
        number: 1,
        board: { owner: 'o', number: 1 },
      }),
    }) as GithubTaskReader

  it('el prerrequisito que llega a Refined despierta a quien bloquea', async () => {
    const fake = withItem(reader('Refine', { 1: [7] }))
    const { result, published } = await run(input, fake, moved('Refined'))
    expect(result).toEqual({ emitted: ['o/r#7'] })
    expect(published.map((e) => e.type)).toEqual(['issue.blockers_refined'])
    expect(published[0]?.payload).toMatchObject({
      blocker: 'o/r#1',
      item: { blockersRefined: true },
    })
  })

  it('un cambio a Refine no despierta a nadie', async () => {
    const fake = withItem(reader('Refine', { 1: [7] }))
    const { result, published } = await run(input, fake, moved('Refine'))
    expect('skipped' in result).toBe(true)
    expect(published).toEqual([])
  })
})
