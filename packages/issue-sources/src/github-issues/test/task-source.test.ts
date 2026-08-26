import { describe, expect, test } from 'bun:test'
import type { Task } from '@ia-flow/shared'
import type { IssueItem } from '../../contract.js'
import type { GitHubIssuesApi } from '../api/issues-client.js'
import { FieldLabelCodec } from '../field-label.js'
import type { GitHubIssueSourceConfig } from '../source.js'
import { StatusLabelCodec } from '../status-label.js'
import { GitHubIssueTaskSource } from '../task-source.js'

// Same DI pattern as source.test.ts — a fake GitHubIssuesApi instead of
// mocking `fetch`.
function fakeApi(overrides: Partial<GitHubIssuesApi> = {}): GitHubIssuesApi {
  return {
    listIssues: async () => [],
    getByNumber: async () => null,
    getById: async () => null,
    listRepoLabels: async () => [],
    replaceLabels: async () => {},
    create: async () => {
      throw new Error('not stubbed')
    },
    addComment: async () => {},
    listComments: async () => [],
    updateBody: async () => {},
    getBlockers: async () => [],
    addBlockedBy: async () => {},
    getDevLinks: async () => new Map(),
    ...overrides,
  } as GitHubIssuesApi
}

const CONFIG: GitHubIssueSourceConfig = {
  owner: 'la-haus',
  repo: 'ia-flow',
  anchorLabel: 'ia-flow-refine',
}

const ITEM: IssueItem = {
  id: 'ISSUE_1',
  title: 'Do the thing',
  description: 'Body text',
  status: 'refine',
  type: '',
  repos: ['ia-flow'],
  issueNumber: 42,
  labels: ['ia-flow-refine', 'status:refine'],
  meta: { issueId: 'I_node1', issueNumber: 42 },
}

function makeManager(item: IssueItem = ITEM): GitHubIssueTaskSource {
  return new GitHubIssueTaskSource(
    CONFIG,
    fakeApi(),
    new StatusLabelCodec(),
    new FieldLabelCodec(),
    item,
    () => {},
  )
}

describe('GitHubIssueTaskSource.getSourceToolContext', () => {
  test('returns owner/repoName/issue identity with no projectId — no Projects v2 board here', () => {
    const manager = makeManager()
    const ctx = manager.getSourceToolContext()

    expect(ctx.owner).toBe('la-haus')
    expect(ctx.repoName).toBe('ia-flow')
    expect(ctx.issueId).toBe('I_node1')
    expect(ctx.issueNumber).toBe(42)
    expect(ctx.projectId).toBeUndefined()
    expect(ctx.fields).toEqual({})
  })
})

// ─── setFields — campo multi-valor `Labels` ──────────────────────────────────
//
// Este source guarda TODO en labels (status, campos, bookkeeping), así que es
// el único donde un outcome `$set:Labels=...` puede pisarse con la maquinaria
// del propio engine. Las ops se resuelven contra las labels FRESCAS del issue
// (no contra el snapshot del item, que puede estar viejo) y un reemplazo
// total no puede llevarse puesto el anchor ni el `status:*` vigente.

const TASK: Task = {
  id: 'ISSUE_1',
  title: 'Do the thing',
  description: 'Body text',
  type: 'functional',
  repos: ['ia-flow'],
  status: 'refine',
  created_at: '2024-01-01T00:00:00Z',
  labels: ['ia-flow-refine', 'status:refine'],
}

function makeManagerWith(
  fresh: string[],
  onReplace: (labels: string[]) => void,
): GitHubIssueTaskSource {
  const api = fakeApi({
    getByNumber: async () => ({
      id: 'I_node1',
      number: 42,
      title: 'Do the thing',
      body: 'Body text',
      state: 'open' as const,
      labels: fresh,
      assignees: [],
      url: 'https://github.com/la-haus/ia-flow/issues/42',
    }),
    replaceLabels: async (_owner: string, _repo: string, _n: number, labels: string[]) => {
      onReplace(labels)
    },
  })
  return new GitHubIssueTaskSource(
    CONFIG,
    api,
    new StatusLabelCodec(),
    new FieldLabelCodec(),
    ITEM,
    () => {},
  )
}

describe('GitHubIssueTaskSource.setFields — campo multi-valor Labels', () => {
  test('resuelve los tokens con signo contra las labels frescas del issue', async () => {
    let persisted: string[] = []
    const manager = makeManagerWith(['ia-flow-refine', 'status:refine', 'agent:build'], (l) => {
      persisted = l
    })

    const updated = await manager.setFields(TASK, { Labels: '+agent:review,-agent:build' })

    expect(persisted).toContain('agent:review')
    expect(persisted).not.toContain('agent:build')
    expect(persisted).toContain('status:refine')
    expect(updated.labels).toEqual(persisted)
  })

  test('un reemplazo total no se lleva puesto el anchor ni el status vigente', async () => {
    let persisted: string[] = []
    const manager = makeManagerWith(['ia-flow-refine', 'status:refine', 'bug'], (l) => {
      persisted = l
    })

    await manager.setFields(TASK, { Labels: '=solo-esta' })

    expect(persisted).toContain('solo-esta')
    expect(persisted).toContain('ia-flow-refine')
    expect(persisted).toContain('status:refine')
    expect(persisted).not.toContain('bug')
  })

  test('el spec no se filtra a task.fields — es una operación, no un valor', async () => {
    const manager = makeManagerWith(['ia-flow-refine', 'status:refine'], () => {})

    const updated = await manager.setFields(TASK, { Labels: '+agent:review' })

    expect(updated.fields?.Labels).toBeUndefined()
  })

  test('un cambio de status y las labels entran en un mismo batch de escritura', async () => {
    const writes: string[][] = []
    const manager = makeManagerWith(['ia-flow-refine', 'status:refine'], (l) => {
      writes.push(l)
    })

    const updated = await manager.setFields(TASK, { Status: 'build', Labels: '+agent:review' })

    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('status:build')
    expect(writes[0]).toContain('agent:review')
    expect(updated.status).toBe('build')
  })
})
