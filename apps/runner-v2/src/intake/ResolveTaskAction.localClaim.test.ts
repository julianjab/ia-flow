import { describe, expect, it } from 'bun:test'
import {
  createEvent,
  type DomainEvent,
  EventBus,
  type PipelineExecutionContext,
} from '@ia-flow/agent-engine'
import type { GithubTaskReader } from '@ia-flow/github-tools'
import { ResolveTaskAction } from './ResolveTaskAction.js'

const LOCAL = 'aiflow-local'
const LABELED_AT = '2026-10-20T20:43:47Z'
const project = {
  id: 'p',
  board: { owner: 'o', number: 1 },
  repos: ['o/r'],
  reposText: '- r (o/r)',
}
/** El `&owned_tasks` de un deploy: ni trabadas ni tomadas en local. */
const when = [
  { field: 'item.labels', op: 'notContains', value: 'blocked' },
  { field: 'item.labels', op: 'notContains', value: LOCAL },
]

/** `action` (`labeled`/`unlabeled`) de `label` sobre o/r#7. */
const labelEvent = (action: string, label: string) =>
  createEvent('github.issues', {
    action,
    label: { name: label },
    issue: { number: 7, title: 't', labels: [] },
    repository: { name: 'r', full_name: 'o/r', owner: { login: 'o' } },
    sender: { login: 'julian' },
  })

/** o/r#7 en Build, con `labels` y un comentario humano escrito después de `LABELED_AT`. */
function reader(labels: string[]): GithubTaskReader {
  const fake = {
    withItemCache: () => fake,
    withStacking: () => fake,
    itemsOfIssue: async () => [
      {
        id: 'PVTI_1',
        project: { number: 1, owner: { login: 'o' } },
        fieldValues: { nodes: [{ name: 'Build', field: { name: 'Status' } }] },
      },
    ],
    linkedBranches: async () => [],
    labeledAt: async () => LABELED_AT,
    context: async () => ({
      issue: { title: 't', body: '', html_url: 'https://github.com/o/r/issues/7', labels },
      blockers: [],
      issueComments: [
        {
          id: 11,
          body: 'lo hago yo',
          created_at: '2026-10-20T21:00:00Z',
          user: { login: 'julian', type: 'User' },
        },
      ],
    }),
  }
  return fake as unknown as GithubTaskReader
}

async function resolve(event: DomainEvent<unknown>, labels: string[]) {
  const bus = new EventBus()
  const published: DomainEvent<unknown>[] = []
  bus.subscribe('*', (event) => {
    published.push(event)
  })
  const released: Array<{ scope: Record<string, unknown>; reason: string }> = []
  const claims = {
    label: LOCAL,
    release: (scope: Record<string, unknown>, reason: string) => released.push({ scope, reason }),
  }
  const ctx = {
    event,
    bus,
    capabilities: { invoke: async () => ({ branch: 'feat/x' }) },
  } as unknown as PipelineExecutionContext
  const action = new ResolveTaskAction(
    () => [project],
    reader(labels),
    undefined,
    undefined,
    claims,
  )
  const result = await action.execute(action.input.parse({ when }), ctx)
  return { result, published, released }
}

describe('resolve_task con una task tomada en local', () => {
  it('al ponerle el label local, suelta lo vivo de la task (con su scope) y no publica nada', async () => {
    const { result, published, released } = await resolve(labelEvent('labeled', LOCAL), [LOCAL])
    expect('skipped' in result && result.skipped).toMatch(/no cumple el when del intake/)
    expect(published).toEqual([])
    expect(released).toEqual([
      {
        scope: expect.objectContaining({ projectId: 'p', issue: 'o/r#7' }),
        reason: `la tomó una sesión local (label ${LOCAL})`,
      },
    ])
  })

  it('otro label que la deja afuera (blocked) no suelta nada', async () => {
    const { released } = await resolve(labelEvent('labeled', 'blocked'), ['blocked'])
    expect(released).toEqual([])
  })

  it('un evento cualquiera de una task tomada no vuelve a soltar', async () => {
    const { released } = await resolve(labelEvent('labeled', 'e2e-test'), [LOCAL, 'e2e-test'])
    expect(released).toEqual([])
  })

  it('al sacarle el label local, NO re-entrega lo comentado mientras tanto: ya lo atendió la sesión', async () => {
    const { published } = await resolve(labelEvent('unlabeled', LOCAL), [])
    expect(published.map((event) => event.type)).toEqual(['issue.unlabeled'])
  })

  it('al sacarle blocked sí lo re-entrega, como siempre', async () => {
    const { published } = await resolve(labelEvent('unlabeled', 'blocked'), [])
    expect(published.map((event) => event.type)).toEqual(['issue.unlabeled', 'issue_comment'])
  })
})
